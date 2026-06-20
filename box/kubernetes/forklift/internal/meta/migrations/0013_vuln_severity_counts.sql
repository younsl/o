-- Per-severity advisory histogram for a scan, stored as a JSON object keyed by
-- severity label (e.g. {"critical":2,"high":5}). Lets the approval queue render
-- a per-level vulnerability breakdown without re-querying the advisory source.
ALTER TABLE vuln_scans ADD COLUMN severity_counts TEXT NOT NULL DEFAULT '{}';
