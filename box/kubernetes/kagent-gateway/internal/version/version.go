// Package version exposes build-time version information injected via ldflags.
package version

// Version is the semantic version of the binary. It is overridden at build
// time with -ldflags "-X .../internal/version.Version=x.y.z" and otherwise
// reports "dev" for local builds.
var Version = "dev"

// Commit is the git SHA the binary was built from. Overridden at build time.
var Commit = "none"
