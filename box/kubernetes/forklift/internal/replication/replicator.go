package replication

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"iter"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/younsl/o/box/kubernetes/forklift/internal/meta"
	"github.com/younsl/o/box/kubernetes/forklift/internal/storage"
)

// LeaderResolver returns the base URL of the current leader, or "" when the
// leader is unknown or is this instance (in which case the standby skips the
// sync cycle).
type LeaderResolver func(ctx context.Context) (string, error)

// StaticLeaderURL resolves to a fixed URL (testing / non-Kubernetes setups).
func StaticLeaderURL(u string) LeaderResolver {
	return func(context.Context) (string, error) { return u, nil }
}

// leaseHolder is implemented by cluster.Elector.
type leaseHolder interface {
	LeaderIdentity(ctx context.Context) (string, error)
}

// LeaseLeaderURL resolves the leader pod through the Lease holder identity and
// the headless Service domain: http://<holder>.<peerService>:<port>. It returns
// "" when this instance holds the Lease.
func LeaseLeaderURL(holder leaseHolder, selfIdentity, peerService string, port int) LeaderResolver {
	return func(ctx context.Context) (string, error) {
		id, err := holder.LeaderIdentity(ctx)
		if err != nil {
			return "", err
		}
		if id == "" || id == selfIdentity {
			return "", nil
		}
		return fmt.Sprintf("http://%s.%s:%d", id, peerService, port), nil
	}
}

// Options configures a Replicator.
type Options struct {
	Store      *meta.Store
	Blobs      *storage.FSStore
	DataDir    string
	Token      string
	Interval   time.Duration
	LeaderURL  LeaderResolver
	Log        *slog.Logger
	Registerer prometheus.Registerer
}

// Replicator is the standby-side pull loop. Every interval, while this
// instance is not the leader, it downloads a fresh SQLite snapshot, mirrors
// the leader's blob set onto the local volume, and only then commits the
// snapshot, so a committed snapshot never references blobs that were not
// mirrored. Promote applies the latest committed snapshot when leadership is
// acquired.
type Replicator struct {
	store     *meta.Store
	blobs     *storage.FSStore
	dataDir   string
	token     string
	interval  time.Duration
	leaderURL LeaderResolver
	log       *slog.Logger
	client    *http.Client

	isLeader atomic.Bool

	// syncMu serializes sync cycles with promotion so Promote never races a
	// half-written snapshot.
	syncMu sync.Mutex
	// snapshotPath is the last snapshot fully downloaded during this process's
	// standby phase; "" when none. Stale on-disk snapshots from previous runs
	// are deliberately ignored (and removed at startup): applying one on a pod
	// that was recently the leader would roll back its newer local data.
	snapshotPath string

	syncs         *prometheus.CounterVec
	blobsFetched  prometheus.Counter
	blobsDeleted  prometheus.Counter
	lastSyncUnix  prometheus.Gauge
	snapshotBytes prometheus.Gauge
}

// New builds a Replicator and registers its metrics.
func New(o Options) *Replicator {
	r := &Replicator{
		store:     o.Store,
		blobs:     o.Blobs,
		dataDir:   o.DataDir,
		token:     o.Token,
		interval:  o.Interval,
		leaderURL: o.LeaderURL,
		log:       o.Log,
		client:    &http.Client{Timeout: 5 * time.Minute},
		syncs: prometheus.NewCounterVec(prometheus.CounterOpts{
			Namespace: "forklift",
			Name:      "replication_syncs_total",
			Help:      "Replication sync cycles by result.",
		}, []string{"result"}),
		blobsFetched: prometheus.NewCounter(prometheus.CounterOpts{
			Namespace: "forklift",
			Name:      "replication_blobs_fetched_total",
			Help:      "Blobs downloaded from the leader.",
		}),
		blobsDeleted: prometheus.NewCounter(prometheus.CounterOpts{
			Namespace: "forklift",
			Name:      "replication_blobs_deleted_total",
			Help:      "Local blobs deleted because the leader no longer has them.",
		}),
		lastSyncUnix: prometheus.NewGauge(prometheus.GaugeOpts{
			Namespace: "forklift",
			Name:      "replication_last_sync_timestamp_seconds",
			Help:      "Unix time of the last successful sync cycle.",
		}),
		snapshotBytes: prometheus.NewGauge(prometheus.GaugeOpts{
			Namespace: "forklift",
			Name:      "replication_snapshot_bytes",
			Help:      "Size of the last downloaded database snapshot.",
		}),
	}
	if o.Registerer != nil {
		o.Registerer.MustRegister(r.syncs, r.blobsFetched, r.blobsDeleted, r.lastSyncUnix, r.snapshotBytes)
	}
	return r
}

func (r *Replicator) replicaDir() string { return filepath.Join(r.dataDir, "replica") }

// Run executes the pull loop until ctx is cancelled. Stale snapshots from
// previous runs are removed first so Promote only ever applies data pulled
// during this process's standby phase.
func (r *Replicator) Run(ctx context.Context) {
	if err := os.RemoveAll(r.replicaDir()); err != nil {
		r.log.Warn("replication: clean stale replica dir", "err", err)
	}
	ticker := time.NewTicker(r.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if r.isLeader.Load() {
				continue
			}
			if err := r.sync(ctx); err != nil && ctx.Err() == nil {
				r.syncs.WithLabelValues("error").Inc()
				r.log.Error("replication: sync failed", "err", err)
			}
		}
	}
}

func (r *Replicator) sync(ctx context.Context) error {
	r.syncMu.Lock()
	defer r.syncMu.Unlock()
	if r.isLeader.Load() {
		return nil
	}
	leader, err := r.leaderURL(ctx)
	if err != nil {
		return fmt.Errorf("resolve leader: %w", err)
	}
	if leader == "" {
		return nil
	}
	// Snapshot first, blobs second, commit last. The blob listing reflects
	// the leader's live database, which is at least as new as the snapshot,
	// so every blob a committed snapshot references has been mirrored before
	// Promote can apply it. Committing before the blob sync would let a
	// failover serve metadata whose blobs were never fetched.
	tmp, size, err := r.downloadSnapshot(ctx, leader)
	if err != nil {
		return fmt.Errorf("sync db: %w", err)
	}
	if err := r.syncBlobs(ctx, leader); err != nil {
		os.Remove(tmp)
		return fmt.Errorf("sync blobs: %w", err)
	}
	final := filepath.Join(r.replicaDir(), "forklift.db")
	if err := os.Rename(tmp, final); err != nil {
		os.Remove(tmp)
		return fmt.Errorf("commit snapshot: %w", err)
	}
	r.snapshotPath = final
	r.snapshotBytes.Set(float64(size))
	r.syncs.WithLabelValues("ok").Inc()
	r.lastSyncUnix.SetToCurrentTime()
	return nil
}

// syncBlobs mirrors the leader's blob set: both sides enumerate digests in
// lexicographic order, so a streaming merge finds missing and extra blobs
// without holding either set in memory. Blobs are immutable and content-
// addressed, which makes fetch and delete both idempotent.
func (r *Replicator) syncBlobs(ctx context.Context, leader string) error {
	var localErr error
	localSeq := func(yield func(string) bool) {
		err := r.blobs.WalkDigests(ctx, func(d string) error {
			if !yield(d) {
				return errStopWalk
			}
			return nil
		})
		if err != nil && !errors.Is(err, errStopWalk) {
			localErr = err
		}
	}
	var remoteErr error
	remoteSeq := func(yield func(string) bool) {
		after := ""
		for {
			page, err := r.fetchBlobPage(ctx, leader, after)
			if err != nil {
				remoteErr = err
				return
			}
			if len(page) == 0 {
				return
			}
			for _, d := range page {
				if !yield(d) {
					return
				}
			}
			after = page[len(page)-1]
		}
	}

	nextLocal, stopLocal := iter.Pull(iter.Seq[string](localSeq))
	defer stopLocal()
	nextRemote, stopRemote := iter.Pull(iter.Seq[string](remoteSeq))
	defer stopRemote()

	l, lok := nextLocal()
	rd, rok := nextRemote()
	for (lok || rok) && localErr == nil && remoteErr == nil {
		switch {
		case !lok || (rok && rd < l):
			if err := r.fetchBlob(ctx, leader, rd); err != nil {
				return err
			}
			rd, rok = nextRemote()
		case !rok || l < rd:
			if err := r.blobs.Delete(ctx, l); err != nil {
				return fmt.Errorf("delete extra blob %s: %w", l, err)
			}
			r.blobsDeleted.Inc()
			l, lok = nextLocal()
		default:
			l, lok = nextLocal()
			rd, rok = nextRemote()
		}
	}
	if localErr != nil {
		return fmt.Errorf("walk local blobs: %w", localErr)
	}
	if remoteErr != nil {
		return fmt.Errorf("list leader blobs: %w", remoteErr)
	}
	return nil
}

var errStopWalk = errors.New("stop walk")

func (r *Replicator) fetchBlobPage(ctx context.Context, leader, after string) ([]string, error) {
	u := leader + "/internal/replication/blobs?limit=" + fmt.Sprint(defaultPageSize) +
		"&after=" + url.QueryEscape(after)
	resp, err := r.get(ctx, u)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("list blobs: status %d", resp.StatusCode)
	}
	var page blobPage
	if err := json.NewDecoder(resp.Body).Decode(&page); err != nil {
		return nil, fmt.Errorf("decode blob page: %w", err)
	}
	return page.Digests, nil
}

func (r *Replicator) fetchBlob(ctx context.Context, leader, digest string) error {
	resp, err := r.get(ctx, leader+"/internal/replication/blobs/"+digest)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	// The leader may have garbage-collected the blob since listing it.
	if resp.StatusCode == http.StatusNotFound {
		return nil
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("fetch blob %s: status %d", digest, resp.StatusCode)
	}
	got, _, err := r.blobs.Put(ctx, resp.Body)
	if err != nil {
		return fmt.Errorf("store blob %s: %w", digest, err)
	}
	// Put re-hashes the stream, so a digest mismatch means corruption in flight.
	if got != digest {
		_ = r.blobs.Delete(ctx, got)
		return fmt.Errorf("blob digest mismatch: want %s got %s", digest, got)
	}
	r.blobsFetched.Inc()
	return nil
}

// downloadSnapshot fetches a fresh snapshot into a temp file and returns its
// path and size. The caller commits it with an atomic rename only after the
// blob sync succeeds, so Promote never sees a partial or blob-incomplete
// snapshot.
func (r *Replicator) downloadSnapshot(ctx context.Context, leader string) (string, int64, error) {
	if err := os.MkdirAll(r.replicaDir(), 0o755); err != nil {
		return "", 0, fmt.Errorf("create replica dir: %w", err)
	}
	resp, err := r.get(ctx, leader+"/internal/replication/db")
	if err != nil {
		return "", 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", 0, fmt.Errorf("fetch snapshot: status %d", resp.StatusCode)
	}

	tmp := filepath.Join(r.replicaDir(), "forklift.db.tmp")
	f, err := os.Create(tmp)
	if err != nil {
		return "", 0, fmt.Errorf("create snapshot file: %w", err)
	}
	n, err := io.Copy(f, resp.Body)
	if err != nil {
		f.Close()
		os.Remove(tmp)
		return "", 0, fmt.Errorf("download snapshot: %w", err)
	}
	if err := f.Sync(); err != nil {
		f.Close()
		os.Remove(tmp)
		return "", 0, fmt.Errorf("sync snapshot: %w", err)
	}
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return "", 0, fmt.Errorf("close snapshot: %w", err)
	}
	return tmp, n, nil
}

func (r *Replicator) get(ctx context.Context, u string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+r.token)
	return r.client.Do(req)
}

// Promote is called when this instance acquires leadership, before it reports
// Ready. If a snapshot was replicated during the standby phase it replaces the
// local database; otherwise the local data is served as-is (first start, or a
// re-elected former leader).
func (r *Replicator) Promote(ctx context.Context) error {
	r.isLeader.Store(true)
	r.syncMu.Lock()
	defer r.syncMu.Unlock()
	path := r.snapshotPath
	r.snapshotPath = ""
	if path == "" {
		r.log.Info("replication: promoting with local data (no replicated snapshot)")
		return nil
	}
	if err := r.store.SwapFromSnapshot(ctx, path); err != nil {
		return fmt.Errorf("apply replicated snapshot: %w", err)
	}
	r.log.Info("replication: promoted with replicated snapshot")
	return nil
}

// Demote is called when leadership is lost; the pull loop resumes.
func (r *Replicator) Demote() {
	r.isLeader.Store(false)
}
