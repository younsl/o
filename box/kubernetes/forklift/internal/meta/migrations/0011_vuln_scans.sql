-- Known-vulnerability scan results per package coordinate, keyed by ecosystem
-- so the same package shared by several proxies is scanned once. max_severity is
-- the highest severity across non-withdrawn advisories (empty/none when clean),
-- vuln_ids is a JSON array of advisory ids, and scanned_at drives periodic
-- re-scanning so newly disclosed advisories on already-cached versions surface.

CREATE TABLE vuln_scans (
    ecosystem    TEXT NOT NULL,
    package      TEXT NOT NULL,
    version      TEXT NOT NULL,
    max_severity TEXT NOT NULL DEFAULT '',
    vuln_ids     TEXT NOT NULL DEFAULT '',
    scanned_at   TEXT NOT NULL,
    PRIMARY KEY (ecosystem, package, version)
);

CREATE INDEX idx_vuln_scans_scanned_at ON vuln_scans(scanned_at);
