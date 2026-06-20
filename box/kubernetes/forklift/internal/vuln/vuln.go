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

// Advisory is one matched advisory: its id (CVE preferred over GHSA/OSV), the
// derived severity, and the raw CVSS score string from the source when present
// (a numeric base score or a CVSS vector; empty when the source gives none).
type Advisory struct {
	ID       string
	Severity string
	Score    string
}

// Finding is the result of scanning one coordinate: the advisories that apply,
// the highest severity among them, and a per-severity count. IDs and Advisories
// are empty when the coordinate is clean.
type Finding struct {
	IDs        []string
	Advisories []Advisory
	Max        Severity
	// Counts holds the number of advisories at each severity, indexed by the
	// Severity value (Counts[SevCritical], etc.).
	Counts [5]int
}

// SeverityCounts returns the non-zero per-severity advisory counts keyed by the
// severity label (e.g. {"critical": 2, "high": 5}), for storage and display.
func (f Finding) SeverityCounts() map[string]int {
	out := map[string]int{}
	for sev := SevLow; sev <= SevCritical; sev++ {
		if f.Counts[sev] > 0 {
			out[sev.String()] = f.Counts[sev]
		}
	}
	return out
}

// Scanner queries an advisory source for vulnerabilities affecting a coordinate.
// An empty version is a package-level query: the result covers every advisory
// affecting the package across all versions. Source names the advisory data
// source (e.g. "OSV"), recorded on each scan so the report attributes its data
// and stays meaningful as more sources are added.
type Scanner interface {
	Query(ctx context.Context, ecosystem, pkg, version string) (Finding, error)
	Source() string
}
