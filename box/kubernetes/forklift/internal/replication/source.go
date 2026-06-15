// Package replication implements PV-based active/standby replication. Each
// replica keeps its own (ReadWriteOnce) PersistentVolume; the standby
// continuously pulls the leader's SQLite snapshot and content-addressed blobs
// over token-authenticated internal HTTP endpoints, then promotes that copy
// when it acquires leadership. This removes the ReadWriteMany storage
// requirement of the shared-volume HA mode at the cost of asynchronous
// replication: writes within one pull interval can be lost on failover.
package replication

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"sync"

	"github.com/go-chi/chi/v5"

	"github.com/younsl/o/box/kubernetes/forklift/internal/meta"
	"github.com/younsl/o/box/kubernetes/forklift/internal/storage"
)

// defaultPageSize caps one blob digest listing response.
const defaultPageSize = 1000

// Source serves the leader-side replication endpoints. The endpoints expose
// the full database (including credential hashes), so they are guarded by a
// shared bearer token and must not be exposed outside the cluster.
type Source struct {
	store   *meta.Store
	blobs   *storage.FSStore
	token   string
	dataDir string
	log     *slog.Logger

	// snapshotMu serializes snapshot generation; there is only one standby.
	snapshotMu sync.Mutex
}

// NewSource builds the leader-side handler set.
func NewSource(store *meta.Store, blobs *storage.FSStore, token, dataDir string, log *slog.Logger) *Source {
	return &Source{store: store, blobs: blobs, token: token, dataDir: dataDir, log: log}
}

// Routes returns the replication endpoints, all gated by the shared token.
func (s *Source) Routes() http.Handler {
	r := chi.NewRouter()
	r.Use(s.requireToken)
	r.Get("/db", s.handleDB)
	r.Get("/blobs", s.handleListBlobs)
	r.Get("/blobs/{digest}", s.handleGetBlob)
	return r
}

func (s *Source) requireToken(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got := r.Header.Get("Authorization")
		want := "Bearer " + s.token
		if s.token == "" || subtle.ConstantTimeCompare([]byte(got), []byte(want)) != 1 {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// handleDB streams a consistent point-in-time SQLite snapshot (VACUUM INTO),
// which is a single clean database file with no WAL sidecars.
func (s *Source) handleDB(w http.ResponseWriter, r *http.Request) {
	s.snapshotMu.Lock()
	defer s.snapshotMu.Unlock()

	dir := filepath.Join(s.dataDir, "replication")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		s.log.Error("replication: create snapshot dir", "err", err)
		http.Error(w, "snapshot failed", http.StatusInternalServerError)
		return
	}
	path := filepath.Join(dir, "snapshot.db")
	defer os.Remove(path)

	if err := s.store.Snapshot(r.Context(), path); err != nil {
		s.log.Error("replication: snapshot", "err", err)
		http.Error(w, "snapshot failed", http.StatusInternalServerError)
		return
	}
	f, err := os.Open(path)
	if err != nil {
		s.log.Error("replication: open snapshot", "err", err)
		http.Error(w, "snapshot failed", http.StatusInternalServerError)
		return
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		s.log.Error("replication: stat snapshot", "err", err)
		http.Error(w, "snapshot failed", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", strconv.FormatInt(fi.Size(), 10))
	if _, err := io.Copy(w, f); err != nil {
		s.log.Warn("replication: stream snapshot", "err", err)
	}
}

// blobPage is the digest listing response.
type blobPage struct {
	Digests []string `json:"digests"`
}

// handleListBlobs returns blob digests ordered by sha256, strictly after the
// "after" cursor. An empty page means the listing is complete.
func (s *Source) handleListBlobs(w http.ResponseWriter, r *http.Request) {
	after := r.URL.Query().Get("after")
	limit := defaultPageSize
	if v := r.URL.Query().Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n <= 0 || n > defaultPageSize {
			http.Error(w, "invalid limit", http.StatusBadRequest)
			return
		}
		limit = n
	}
	digests, err := s.store.ListBlobDigests(r.Context(), after, limit)
	if err != nil {
		s.log.Error("replication: list blobs", "err", err)
		http.Error(w, "list failed", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(blobPage{Digests: digests})
}

func (s *Source) handleGetBlob(w http.ResponseWriter, r *http.Request) {
	digest := chi.URLParam(r, "digest")
	rc, size, err := s.blobs.Open(r.Context(), digest)
	if errors.Is(err, storage.ErrNotFound) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if err != nil {
		s.log.Error("replication: open blob", "digest", digest, "err", err)
		http.Error(w, "open failed", http.StatusInternalServerError)
		return
	}
	defer rc.Close()
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", fmt.Sprintf("%d", size))
	if _, err := io.Copy(w, rc); err != nil {
		s.log.Warn("replication: stream blob", "digest", digest, "err", err)
	}
}
