package repo

import (
	"context"
	"time"
)

// RunSweeper periodically reclaims blob bytes whose reference count has dropped
// to zero (after artifact deletion or cache eviction). It is leader-gated by the
// caller in HA mode so only one instance mutates the blob store.
func (e *Engine) RunSweeper(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			e.sweepOnce(ctx)
		}
	}
}

func (e *Engine) sweepOnce(ctx context.Context) {
	shas, err := e.store.ListUnreferencedBlobs(ctx, 256)
	if err != nil {
		e.log.Error("sweeper list failed", "err", err)
		return
	}
	for _, sha := range shas {
		if err := e.blobs.Delete(ctx, sha); err != nil {
			e.log.Error("sweeper blob delete failed", "sha", sha, "err", err)
			continue
		}
		if err := e.store.DeleteBlobRecord(ctx, sha); err != nil {
			e.log.Error("sweeper record delete failed", "sha", sha, "err", err)
		}
	}
	if len(shas) > 0 {
		e.log.Debug("sweeper reclaimed blobs", "count", len(shas))
	}
}
