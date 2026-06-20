-- The advisory data source that produced this scan (e.g. "OSV"), so the scan
-- report attributes its origin and stays clear as more sources are added.
-- Existing rows predate multiple sources and all came from OSV.
ALTER TABLE vuln_scans ADD COLUMN source TEXT NOT NULL DEFAULT 'OSV';
