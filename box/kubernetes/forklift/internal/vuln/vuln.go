// Package vuln looks up known vulnerabilities for a package coordinate
// (ecosystem, name, version) against an advisory database (OSV). It performs
// coordinate matching only: the directly requested version is checked, not its
// transitive dependencies and not the artifact bytes.
package vuln

import "context"

// Severity is an ordered vulnerability severity. Higher is worse.
type Severity int

const (
	SevNone Severity = iota
	SevLow
	SevMedium
	SevHigh
	SevCritical
)

// String returns the lowercase label used in storage and the API.
func (s Severity) String() string {
	switch s {
	case SevCritical:
		return "critical"
	case SevHigh:
		return "high"
	case SevMedium:
		return "medium"
	case SevLow:
		return "low"
	default:
		return "none"
	}
}

// ParseSeverity maps a stored/config label back to a Severity. Unknown labels
// (including "") are SevNone.
func ParseSeverity(s string) Severity {
	switch s {
	case "critical":
		return SevCritical
	case "high":
		return SevHigh
	case "medium":
		return SevMedium
	case "low":
		return SevLow
	default:
		return SevNone
	}
}

// Finding is the result of scanning one coordinate: the advisory ids that apply
// and the highest severity among them. IDs is empty when the coordinate is
// clean.
type Finding struct {
	IDs []string
	Max Severity
}

// Scanner queries an advisory source for vulnerabilities affecting a coordinate.
type Scanner interface {
	Query(ctx context.Context, ecosystem, pkg, version string) (Finding, error)
}
