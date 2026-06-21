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

// scanStored enqueues an immediate vulnerability scan for a freshly stored
// artifact, so a hosted upload is scanned right away instead of waiting for the
// periodic backfill. The version is derived from the artifact path. It is a
// no-op without a scanner, for unscannable formats, or for paths that carry no
// version (e.g. an npm packument index), and deduplicates like any enqueue.
func (m *Manager) scanStored(repo meta.Repository, artifactPath string) {
	if m.scanner == nil {
		return
	}
	eco, pkg := VulnCoordinate(repo.Format, artifactPath)
	if pkg == "" {
		return
	}
	version := versionForPath(repo.Format, artifactPath)
	if version == "" {
		return
	}
	m.enqueueScan(eco, pkg, version)
}

// versionForPath extracts the version from a stored artifact path using the
// per-format rules, mirroring how the format handlers derive it. Returns "" when
// the path carries no version (metadata/index paths).
func versionForPath(format, artifactPath string) string {
	switch format {
	case meta.FormatMaven:
		return mavenVersion(artifactPath)
	case meta.FormatNPM:
		return npmVersion(artifactPath)
	case meta.FormatCargo:
		return cargoVersion(artifactPath)
	case meta.FormatGo:
		return goVersion(artifactPath)
	case meta.FormatPyPI:
		return pypiVersion(path.Base(artifactPath))
	}
	return ""
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
// queue is full (the next request after the mark expires re-enqueues). An empty
// version enqueues a package-level scan (used by the approval gate when the
// requested version is unknown).
func (m *Manager) enqueueScan(eco, pkg, version string) {
	if m.scanner == nil || eco == "" || pkg == "" {
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
	start := m.engine.now()
	f, err := m.scanner.Query(ctx, job.ecosystem, job.pkg, job.version)
	durationMS := m.engine.now().Sub(start).Milliseconds()
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
	advisories := make([]meta.VulnAdvisory, len(f.Advisories))
	for i, a := range f.Advisories {
		advisories[i] = meta.VulnAdvisory{ID: a.ID, Severity: a.Severity, Score: a.Score}
	}
	if err := m.store.UpsertVulnScan(ctx, job.ecosystem, job.pkg, job.version, f.Max.String(), f.IDs, f.SeverityCounts(), durationMS, advisories, m.scanner.Source()); err != nil {
		m.engine.log.Error("store vuln scan failed",
			"ecosystem", job.ecosystem, "package", job.pkg, "version", job.version, "err", err)
	}
}

// RunVulnBackfill scans already-stored artifacts that have never been scanned,
// so vulnerability data exists for packages uploaded (hosted) or cached (proxy)
// before a scan ever covered them. It sweeps once immediately and then every
// interval. Leader-gated by the caller (only one instance should drive the
// queue). A no-op without a scanner.
func (m *Manager) RunVulnBackfill(ctx context.Context, interval time.Duration) {
	if m.scanner == nil {
		return
	}
	m.backfillOnce(ctx)
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			m.backfillOnce(ctx)
		}
	}
}

// backfillOnce enqueues a scan for every stored artifact coordinate that has no
// scan yet. Already-scanned coordinates are skipped (the rescanner refreshes
// those); unscannable formats are ignored. Coordinates dropped because the
// queue was full are re-enqueued on the next sweep, since they remain unscanned.
func (m *Manager) backfillOnce(ctx context.Context) {
	scanned, err := m.store.ScannedKeys(ctx)
	if err != nil {
		m.engine.log.Error("vuln backfill: load scanned keys failed", "err", err)
		return
	}
	enqueued := 0
	for offset := 0; ; offset += reapBatch {
		targets, err := m.store.ListScanTargets(ctx, reapBatch, offset)
		if err != nil {
			m.engine.log.Error("vuln backfill: list targets failed", "err", err)
			return
		}
		for _, t := range targets {
			eco, pkg := VulnCoordinate(t.Format, t.Path)
			if pkg == "" {
				continue
			}
			if _, ok := scanned[eco+"\x00"+pkg+"\x00"+t.Version]; ok {
				continue
			}
			m.enqueueScan(eco, pkg, t.Version)
			enqueued++
		}
		if len(targets) < reapBatch {
			break
		}
	}
	if enqueued > 0 {
		m.engine.log.Info("vuln backfill enqueued scans for stored artifacts", "count", enqueued)
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
