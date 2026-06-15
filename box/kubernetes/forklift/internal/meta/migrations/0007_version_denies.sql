-- Per-version deny list (quarantine v2) for proxy repositories. A row blocks
-- one exact (package, version) in one repository, overriding any package-level
-- approval — the package stays trusted while a single poisoned release is cut
-- off. Keyed by repo_name like package_approvals (no foreign key); rows MUST
-- NOT survive repository deletion, so the API layer deletes them explicitly
-- on repo.delete.

CREATE TABLE version_denies (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_name  TEXT NOT NULL,
    package    TEXT NOT NULL,  -- canonical per-format name, same convention as package_approvals
    version    TEXT NOT NULL,  -- exact version as it appears in request paths (go modules keep the "v" prefix)
    reason     TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    UNIQUE (repo_name, package, version)
);
