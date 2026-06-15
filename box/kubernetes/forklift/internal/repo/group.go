package repo

import (
	"context"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/younsl/o/box/kubernetes/forklift/internal/auth"
	"github.com/younsl/o/box/kubernetes/forklift/internal/meta"
	"github.com/younsl/o/box/kubernetes/forklift/internal/repoconfig"
)

// viaGroupKey marks a request that was authorized at the group level, so the
// member handler's own authorization is skipped (Nexus semantics: privileges on
// the group govern access through it, member privileges are not required).
type viaGroupCtxKey int

const viaGroupKey viaGroupCtxKey = 0

// grouped intercepts requests to group repositories and fans them out to the
// member repositories in order, serving the first hit. It is format-agnostic:
// member attempts re-enter the wrapped format handler with the {repo} URL
// param rewritten, so every protocol gets group support for free. Non-group
// repositories pass through untouched.
func (m *Manager) grouped(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := chi.URLParam(r, "repo")
		repo, err := m.store.GetRepositoryByName(r.Context(), name)
		if err != nil || repo.Type != meta.TypeGroup {
			// Unknown repos fall through so the format handler emits its usual 404.
			next.ServeHTTP(w, r)
			return
		}

		// Groups are read-only; writes go to a member repository directly.
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "group repositories are read-only", http.StatusMethodNotAllowed)
			return
		}
		if !m.authorize(w, r, name, auth.ActionRead) {
			return
		}
		cfg, err := repoconfig.Parse(repo.ConfigJSON)
		if err != nil {
			http.Error(w, "invalid repository config", http.StatusInternalServerError)
			return
		}

		ctx := context.WithValue(r.Context(), viaGroupKey, true)
		for _, member := range cfg.Group.Members {
			// Deleted members are skipped: the inner handler 404s and the
			// groupWriter treats that as a miss.
			gw := &groupWriter{dst: w, header: http.Header{}}
			next.ServeHTTP(gw, requestWithRepoParam(r.WithContext(ctx), member))
			if !gw.missed {
				return
			}
		}
		http.NotFound(w, r)
	})
}

// viaGroup reports whether the request was already authorized at group level.
func viaGroup(ctx context.Context) bool {
	v, _ := ctx.Value(viaGroupKey).(bool)
	return v
}

// requestWithRepoParam clones the request with the chi {repo} URL param
// replaced, so the wrapped handler resolves the member repository instead.
func requestWithRepoParam(r *http.Request, repo string) *http.Request {
	cur := chi.RouteContext(r.Context())
	rctx := chi.NewRouteContext()
	for i, k := range cur.URLParams.Keys {
		v := cur.URLParams.Values[i]
		if k == "repo" {
			v = repo
		}
		rctx.URLParams.Add(k, v)
	}
	return r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, rctx))
}

// groupWriter buffers the response decision for one member attempt. A 404
// marks a miss (status and body are swallowed so the next member can be
// tried); any other status flushes the buffered headers and streams through,
// which keeps large artifact bodies unbuffered.
type groupWriter struct {
	dst     http.ResponseWriter
	header  http.Header
	decided bool
	missed  bool
}

func (g *groupWriter) Header() http.Header { return g.header }

func (g *groupWriter) WriteHeader(code int) {
	if g.decided {
		return
	}
	g.decided = true
	if code == http.StatusNotFound {
		g.missed = true
		return
	}
	dst := g.dst.Header()
	for k, vs := range g.header {
		dst[k] = vs
	}
	g.dst.WriteHeader(code)
}

func (g *groupWriter) Write(b []byte) (int, error) {
	if !g.decided {
		g.WriteHeader(http.StatusOK)
	}
	if g.missed {
		// Swallow the 404 body; the caller moves on to the next member.
		return len(b), nil
	}
	return g.dst.Write(b)
}

// ValidateGroupMembers enforces group membership invariants that need store
// access: at least one member, every member exists, matches the group's
// format, is not itself a group, and appears only once. Shared by the create
// and update API handlers.
func ValidateGroupMembers(ctx context.Context, store *meta.Store, format string, members []string) error {
	if len(members) == 0 {
		return errors.New("group repository requires at least one member")
	}
	seen := map[string]bool{}
	for _, name := range members {
		if seen[name] {
			return errors.New("duplicate group member: " + name)
		}
		seen[name] = true
		member, err := store.GetRepositoryByName(ctx, name)
		if err != nil {
			if errors.Is(err, meta.ErrNotFound) {
				return errors.New("group member not found: " + name)
			}
			return err
		}
		if member.Format != format {
			return errors.New("group member format mismatch: " + name)
		}
		if member.Type == meta.TypeGroup {
			return errors.New("nested group repositories are not allowed: " + name)
		}
	}
	return nil
}
