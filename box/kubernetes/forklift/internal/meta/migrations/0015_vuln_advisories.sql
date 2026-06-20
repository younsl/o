-- Per-advisory detail for a scan, stored as a JSON array of {id, severity,
-- score} objects, so the approval detail page can render a table of advisories
-- (id, severity, CVSS score, link) without re-querying the advisory source.
ALTER TABLE vuln_scans ADD COLUMN advisories TEXT NOT NULL DEFAULT '[]';
