package repo

import (
	"context"
	"path"
	"time"

	"github.com/younsl/o/box/kubernetes/forklift/internal/meta"
)

// VulnCoordinate returns the OSV ecosystem and package name for an artifact path
// of the given format, for joining stored scan results to listed artifacts.
// Returns empty strings when the format has no scannable coordinate.
func VulnCoordinate(format, artifactPath string) (ecosystem, pkg string) {
	eco := osvEcosystem(format)
	if eco == "" {
		return "", ""
	}
	switch format {
	case meta.FormatMaven:
		return eco, mavenPackage(artifactPath)
	case meta.FormatNPM:
		return eco, npmPackage(artifactPath)
	case meta.FormatCargo:
		return eco, cargoPackage(artifactPath)
	case meta.FormatGo:
		return eco, goPackage(artifactPath)
	case meta.FormatPyPI:
		return eco, pypiPackageFromFilename(path.Base(artifactPath))
	}
	return "", ""
}

// scanJob is a queued vulnerability scan for one package coordinate.
type scanJob struct {
	ecosystem string
	pkg       string
	version   string
}

// OSVEcosystem maps a forklift repository format to its OSV ecosystem name,
// exported so the API can join stored scans to approvals/artifacts. Returns ""
// for formats OSV does not cover.
func OSVEcosystem(format string) string { return osvEcosystem(format) }

// osvEcosystem maps a forklift repository format to its OSV ecosystem name.
// Returns "" for formats OSV does not cover (the gate then no-ops).
func osvEcosystem(format string) string {
	switch format {
	case meta.FormatMaven:
		return "Maven"
	case meta.FormatNPM:
		return "npm"
	case meta.FormatCargo:
		return "crates.io"
	case meta.FormatGo:
		return "Go"
	case meta.FormatPyPI:
		return "PyPI"
	default:
		return ""
	}
}

// enqueueScan schedules an async scan for a coordinate, deduplicated within the
// pending-mark TTL so hot paths do not flood the queue. Drops silently when the
// queue is full (the next request after the mark expires re-enqueues).
func (m *Manager) enqueueScan(eco, pkg, version string) {
	if m.scanner == nil || eco == "" || pkg == "" || version == "" {
		return
	}
	key := "scan\x00" + eco + "\x00" + pkg + "\x00" + version
	if m.reqMarks.has(key) {
		return
	}
	m.reqMarks.set(key, pendingMarkTTL)
	select {
	case m.scanQueue <- scanJob{ecosystem: eco, pkg: pkg, version: version}:
	default:
	}
}

// RunVulnWorker drains the scan queue, querying the advisory source and storing
// results. It runs until ctx is cancelled. A no-op when no scanner is set.
func (m *Manager) RunVulnWorker(ctx context.Context) {
	if m.scanner == nil {
		return
	}
	for {
		select {
		case <-ctx.Done():
			return
		case job := <-m.scanQueue:
			m.runScan(ctx, job)
		}
	}
}

func (m *Manager) runScan(ctx context.Context, job scanJob) {
	f, err := m.scanner.Query(ctx, job.ecosystem, job.pkg, job.version)
	if err != nil {
		m.vulnScans.WithLabelValues("error").Inc()
		m.engine.log.Warn("vuln scan failed",
			"ecosystem", job.ecosystem, "package", job.pkg, "version", job.version, "err", err)
		return
	}
	if len(f.IDs) == 0 {
		m.vulnScans.WithLabelValues("clean").Inc()
	} else {
		m.vulnScans.WithLabelValues("vulnerable").Inc()
	}
	if err := m.store.UpsertVulnScan(ctx, job.ecosystem, job.pkg, job.version, f.Max.String(), f.IDs); err != nil {
		m.engine.log.Error("store vuln scan failed",
			"ecosystem", job.ecosystem, "package", job.pkg, "version", job.version, "err", err)
	}
}

// RunVulnRescanner periodically re-enqueues scans older than ttl so newly
// disclosed advisories on already-cached versions surface. Leader-gated by the
// caller (only one instance should drive the queue). A no-op without a scanner.
func (m *Manager) RunVulnRescanner(ctx context.Context, interval, ttl time.Duration) {
	if m.scanner == nil {
		return
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			cutoff := m.engine.now().Add(-ttl)
			stale, err := m.store.ListStaleVulnScans(ctx, cutoff, reapBatch)
			if err != nil {
				m.engine.log.Error("vuln rescan list failed", "err", err)
				continue
			}
			for _, s := range stale {
				m.enqueueScan(s.Ecosystem, s.Package, s.Version)
			}
		}
	}
}
