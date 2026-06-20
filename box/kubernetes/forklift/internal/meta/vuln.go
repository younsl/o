package meta

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"
)

// VulnAdvisory is one advisory matched by a scan: its id (CVE/GHSA/OSV), the
// derived severity label, and a CVSS score string when known.
type VulnAdvisory struct {
	ID       string `json:"id"`
	Severity string `json:"severity"`
	Score    string `json:"score,omitempty"`
}

// VulnScan is a stored vulnerability scan result for one package coordinate.
type VulnScan struct {
	Ecosystem      string
	Package        string
	Version        string
	MaxSeverity    string // critical|high|medium|low|none
	VulnIDs        []string
	SeverityCounts map[string]int // per-severity advisory counts (label -> count)
	Advisories     []VulnAdvisory // per-advisory detail (id, severity, score)
	DurationMS     int64          // advisory-source query latency in milliseconds
	Source         string         // advisory data source that produced the scan (e.g. "OSV")
	ScannedAt      time.Time
}

// UpsertVulnScan records (or refreshes) a scan result for a coordinate. counts
// is the per-severity advisory histogram (label -> count); nil is stored as an
// empty object. durationMS is how long the advisory-source query took.
func (s *Store) UpsertVulnScan(ctx context.Context, eco, pkg, version, maxSeverity string, ids []string, counts map[string]int, durationMS int64, advisories []VulnAdvisory, source string) error {
	idsJSON, err := json.Marshal(ids)
	if err != nil {
		return err
	}
	if counts == nil {
		counts = map[string]int{}
	}
	countsJSON, err := json.Marshal(counts)
	if err != nil {
		return err
	}
	if advisories == nil {
		advisories = []VulnAdvisory{}
	}
	advJSON, err := json.Marshal(advisories)
	if err != nil {
		return err
	}
	if source == "" {
		source = "OSV"
	}
	_, err = s.h().ExecContext(ctx,
		`INSERT INTO vuln_scans(ecosystem, package, version, max_severity, vuln_ids, severity_counts, advisories, duration_ms, source, scanned_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(ecosystem, package, version) DO UPDATE SET
             max_severity = excluded.max_severity,
             vuln_ids = excluded.vuln_ids,
             severity_counts = excluded.severity_counts,
             advisories = excluded.advisories,
             duration_ms = excluded.duration_ms,
             source = excluded.source,
             scanned_at = excluded.scanned_at`,
		eco, pkg, version, maxSeverity, string(idsJSON), string(countsJSON), string(advJSON), durationMS, source, nowRFC3339())
	return err
}

// GetVulnScan returns a stored scan result, or ErrNotFound when the coordinate
// has not been scanned yet.
func (s *Store) GetVulnScan(ctx context.Context, eco, pkg, version string) (VulnScan, error) {
	return scanVulnRow(s.h().QueryRowContext(ctx,
		`SELECT ecosystem, package, version, max_severity, vuln_ids, severity_counts, advisories, duration_ms, source, scanned_at
           FROM vuln_scans WHERE ecosystem = ? AND package = ? AND version = ?`,
		eco, pkg, version))
}

// ListStaleVulnScans returns up to limit scans last scanned before the cutoff,
// oldest first, so a re-scanner can refresh them against fresh advisory data.
func (s *Store) ListStaleVulnScans(ctx context.Context, before time.Time, limit int) ([]VulnScan, error) {
	rows, err := s.h().QueryContext(ctx,
		`SELECT ecosystem, package, version, max_severity, vuln_ids, severity_counts, advisories, duration_ms, source, scanned_at
           FROM vuln_scans WHERE scanned_at < ? ORDER BY scanned_at ASC LIMIT ?`,
		before.UTC().Format(time.RFC3339Nano), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []VulnScan
	for rows.Next() {
		v, err := scanVulnRows(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

func scanVulnRow(row *sql.Row) (VulnScan, error) {
	var v VulnScan
	var ids, counts, advisories, scanned string
	err := row.Scan(&v.Ecosystem, &v.Package, &v.Version, &v.MaxSeverity, &ids, &counts, &advisories, &v.DurationMS, &v.Source, &scanned)
	if errors.Is(err, sql.ErrNoRows) {
		return VulnScan{}, ErrNotFound
	}
	if err != nil {
		return VulnScan{}, err
	}
	_ = json.Unmarshal([]byte(ids), &v.VulnIDs)
	_ = json.Unmarshal([]byte(counts), &v.SeverityCounts)
	_ = json.Unmarshal([]byte(advisories), &v.Advisories)
	v.ScannedAt = parseTime(scanned)
	return v, nil
}

func scanVulnRows(rows *sql.Rows) (VulnScan, error) {
	var v VulnScan
	var ids, counts, advisories, scanned string
	if err := rows.Scan(&v.Ecosystem, &v.Package, &v.Version, &v.MaxSeverity, &ids, &counts, &advisories, &v.DurationMS, &v.Source, &scanned); err != nil {
		return VulnScan{}, err
	}
	_ = json.Unmarshal([]byte(ids), &v.VulnIDs)
	_ = json.Unmarshal([]byte(counts), &v.SeverityCounts)
	_ = json.Unmarshal([]byte(advisories), &v.Advisories)
	v.ScannedAt = parseTime(scanned)
	return v, nil
}
