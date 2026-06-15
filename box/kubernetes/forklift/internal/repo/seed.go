package repo

import (
	"context"
	"errors"
	"log/slog"
	"strings"

	"github.com/younsl/o/box/kubernetes/forklift/internal/meta"
	"github.com/younsl/o/box/kubernetes/forklift/internal/repoconfig"
)

// defaultRepo describes a repository to preconfigure on first run.
type defaultRepo struct {
	name     string
	format   string
	typ      string
	upstream string   // proxy only
	members  []string // group only, in lookup order (hosted before proxy)
}

// DefaultRepositories are seeded when SeedDefaultRepos is enabled, mirroring
// the repositories a Nexus install ships with: one proxy of each public
// registry, one local (hosted) repository per format for internal artifacts,
// and one group per format combining both behind a single client URL (the
// Nexus maven-public pattern). Groups are listed last so their members exist
// when they are created.
var DefaultRepositories = []defaultRepo{
	// Proxies of public upstreams.
	{name: "maven-central", format: meta.FormatMaven, typ: meta.TypeProxy, upstream: "https://repo1.maven.org/maven2"},
	{name: "npmjs", format: meta.FormatNPM, typ: meta.TypeProxy, upstream: "https://registry.npmjs.org"},
	{name: "crates-io", format: meta.FormatCargo, typ: meta.TypeProxy, upstream: "https://index.crates.io"},
	{name: "goproxy", format: meta.FormatGo, typ: meta.TypeProxy, upstream: "https://proxy.golang.org"},
	{name: "pypi", format: meta.FormatPyPI, typ: meta.TypeProxy, upstream: "https://pypi.org/simple"},
	// Hosted repositories for internal artifacts.
	{name: "maven-hosted", format: meta.FormatMaven, typ: meta.TypeHosted},
	{name: "npm-hosted", format: meta.FormatNPM, typ: meta.TypeHosted},
	{name: "cargo-hosted", format: meta.FormatCargo, typ: meta.TypeHosted},
	{name: "go-hosted", format: meta.FormatGo, typ: meta.TypeHosted},
	{name: "pypi-hosted", format: meta.FormatPyPI, typ: meta.TypeHosted},
	// Groups: hosted first so internal artifacts shadow public ones.
	{name: "maven-public", format: meta.FormatMaven, typ: meta.TypeGroup, members: []string{"maven-hosted", "maven-central"}},
	{name: "npm-public", format: meta.FormatNPM, typ: meta.TypeGroup, members: []string{"npm-hosted", "npmjs"}},
	{name: "cargo-public", format: meta.FormatCargo, typ: meta.TypeGroup, members: []string{"cargo-hosted", "crates-io"}},
	{name: "go-public", format: meta.FormatGo, typ: meta.TypeGroup, members: []string{"go-hosted", "goproxy"}},
	{name: "pypi-public", format: meta.FormatPyPI, typ: meta.TypeGroup, members: []string{"pypi-hosted", "pypi"}},
}

// SeedDefaults creates any missing default repositories. It is idempotent:
// existing names are skipped, and a create lost to a concurrent replica (UNIQUE
// conflict) is ignored.
func SeedDefaults(ctx context.Context, store *meta.Store, log *slog.Logger) error {
	for _, r := range DefaultRepositories {
		if _, err := store.GetRepositoryByName(ctx, r.name); err == nil {
			continue
		} else if !errors.Is(err, meta.ErrNotFound) {
			return err
		}
		cfg := repoconfig.Default()
		cfg.Group.Members = r.members
		cfgJSON, err := cfg.JSON()
		if err != nil {
			return err
		}
		if _, err := store.CreateRepository(ctx, meta.Repository{
			Name: r.name, Format: r.format, Type: r.typ,
			UpstreamURL: r.upstream, ConfigJSON: cfgJSON,
		}); err != nil {
			if strings.Contains(err.Error(), "UNIQUE") {
				continue
			}
			return err
		}
		log.Info("seeded default repository", "name", r.name, "format", r.format, "type", r.typ)
	}
	return nil
}
