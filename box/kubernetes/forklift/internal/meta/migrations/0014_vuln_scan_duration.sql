-- How long the advisory-source query took for this scan, in milliseconds, so
-- the approval detail page can show scan latency alongside the result.
ALTER TABLE vuln_scans ADD COLUMN duration_ms INTEGER NOT NULL DEFAULT 0;
