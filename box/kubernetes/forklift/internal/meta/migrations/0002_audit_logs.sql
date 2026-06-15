-- Per-repository audit log. Keyed by repo_name (names are immutable) with no
-- foreign key so entries survive repository deletion (the repo.delete event
-- itself refers to a row that no longer exists).

CREATE TABLE audit_logs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_name  TEXT NOT NULL,
    event      TEXT NOT NULL,                 -- download | upload | delete | repo.create | repo.update | repo.delete
    path       TEXT NOT NULL DEFAULT '',
    username   TEXT NOT NULL DEFAULT '',      -- empty = anonymous
    method     TEXT NOT NULL DEFAULT '',
    status     INTEGER NOT NULL DEFAULT 0,
    client_ip  TEXT NOT NULL DEFAULT '',
    user_agent TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);

CREATE INDEX idx_audit_repo ON audit_logs(repo_name, id);
CREATE INDEX idx_audit_created ON audit_logs(created_at);
