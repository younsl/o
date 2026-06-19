package repo

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/younsl/o/box/kubernetes/forklift/internal/audit"
	"github.com/younsl/o/box/kubernetes/forklift/internal/meta"
	"github.com/younsl/o/box/kubernetes/forklift/internal/repoconfig"
)

// reapBatch bounds how many expired artifacts are deleted per repository per
// query, keeping the single-writer SQLite responsive on large sweeps.
const reapBatch = 256

// RunIdleReaper periodically deletes artifacts that have gone unserved past
// their repository's retention idle_ttl. Like RunSweeper it is leader-gated by
// the caller so only one instance writes. Deletions decrement blob references;
// the sweeper reclaims the freed blobs.
func (m *Manager) RunIdleReaper(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if _, err := m.reapOnce(ctx); err != nil {
				m.engine.log.Error("idle reaper failed", "err", err)
			}
		}
	}
}

// reapOnce sweeps every repository once, deleting idle artifacts whose
// repository configures a positive retention idle_ttl, and returns how many it
// removed. Each deletion is recorded in the repository audit log with the
// artifact path so operators can see exactly what (which package@version) was
// auto-removed.
func (m *Manager) reapOnce(ctx context.Context) (int, error) {
	repos, err := m.store.ListRepositories(ctx)
	if err != nil {
		return 0, err
	}
	total := 0
	for _, repo := range repos {
		cfg, err := repoconfig.Parse(repo.ConfigJSON)
		if err != nil {
			m.engine.log.Error("idle reaper: bad repo config", "repo", repo.Name, "err", err)
			continue
		}
		ttl := cfg.Retention.IdleTTL.D()
		if ttl <= 0 {
			continue
		}
		cutoff := m.engine.now().Add(-ttl)
		for {
			arts, err := m.store.ListExpiredArtifacts(ctx, repo.ID, cutoff, reapBatch)
			if err != nil {
				return total, err
			}
			if len(arts) == 0 {
				break
			}
			for _, art := range arts {
				if err := m.store.DeleteArtifact(ctx, repo.ID, art.Path); err != nil {
					if errors.Is(err, meta.ErrNotFound) {
						continue
					}
					return total, err
				}
				total++
				m.ttlExpired.WithLabelValues(repo.Name).Inc()
				m.rec.Record(audit.Event{
					Repo:     repo.Name,
					Action:   meta.EventTTLExpire,
					Path:     art.Path,
					Username: "system",
					Status:   http.StatusOK,
				})
				m.engine.log.Debug("idle artifact reaped",
					"repo", repo.Name, "path", art.Path, "version", art.Version)
			}
			if len(arts) < reapBatch {
				break
			}
		}
	}
	return total, nil
}
