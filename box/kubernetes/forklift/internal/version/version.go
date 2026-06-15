// Package version holds build-time metadata injected via -ldflags.
package version

// These values are overridden at build time with -X linker flags.
var (
	Version = "dev"
	Commit  = "none"
)

// String returns a human-readable version string.
func String() string {
	return Version + " (" + Commit + ")"
}
