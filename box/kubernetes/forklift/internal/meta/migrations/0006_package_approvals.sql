-- Package approval decisions (quarantine) for proxy repositories. Keyed by
-- repo_name like audit_logs (names are immutable, no foreign key); unlike audit
-- history, approvals MUST NOT survive repository deletion (a recreated same-name
-- repo would silently inherit trust decisions), so the API layer deletes a
-- repository's rows explicitly on repo.delete.

CREATE TABLE package_approvals (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_name          TEXT NOT NULL,
    package            TEXT NOT NULL,             -- canonical per-format name: npm pkg, pypi normalized, maven group:artifact, crate, go module path
    status             TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected
    requested_by       TEXT NOT NULL DEFAULT '',  -- first requester, empty = anonymous
    decided_by         TEXT NOT NULL DEFAULT '',
    note               TEXT NOT NULL DEFAULT '',
    request_count      INTEGER NOT NULL DEFAULT 1,
    first_requested_at TEXT NOT NULL,
    last_requested_at  TEXT NOT NULL,
    decided_at         TEXT,
    UNIQUE (repo_name, package)
);

CREATE INDEX idx_approvals_status ON package_approvals(status, repo_name, id);
