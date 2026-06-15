package repo

import (
	"context"
	"io"
	"log/slog"
	"path/filepath"
	"testing"

	"github.com/younsl/o/box/kubernetes/forklift/internal/meta"
	"github.com/younsl/o/box/kubernetes/forklift/internal/repoconfig"
)

func TestSeedDefaults(t *testing.T) {
	store, err := meta.Open(context.Background(), filepath.Join(t.TempDir(), "seed.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	ctx := context.Background()

	if err := SeedDefaults(ctx, store, log); err != nil {
		t.Fatal(err)
	}
	repos, _ := store.ListRepositories(ctx)
	if len(repos) != len(DefaultRepositories) {
		t.Fatalf("seeded %d, want %d", len(repos), len(DefaultRepositories))
	}
	// Idempotent: a second run creates nothing new.
	if err := SeedDefaults(ctx, store, log); err != nil {
		t.Fatal(err)
	}
	if r2, _ := store.ListRepositories(ctx); len(r2) != len(DefaultRepositories) {
		t.Fatalf("after reseed %d, want %d", len(r2), len(DefaultRepositories))
	}

	// Expect proxy, local and group defaults, with proxies carrying an upstream
	// and every group member valid.
	var proxies, locals, groups int
	for _, r := range repos {
		switch r.Type {
		case meta.TypeProxy:
			proxies++
			if r.UpstreamURL == "" {
				t.Fatalf("proxy %s missing upstream", r.Name)
			}
		case meta.TypeHosted:
			locals++
		case meta.TypeGroup:
			groups++
			cfg, err := repoconfig.Parse(r.ConfigJSON)
			if err != nil {
				t.Fatalf("group %s config: %v", r.Name, err)
			}
			if err := ValidateGroupMembers(ctx, store, r.Format, cfg.Group.Members); err != nil {
				t.Fatalf("group %s members invalid: %v", r.Name, err)
			}
		}
	}
	if proxies == 0 || locals == 0 || groups == 0 {
		t.Fatalf("expected proxy, local and group defaults, got proxies=%d locals=%d groups=%d", proxies, locals, groups)
	}
}
