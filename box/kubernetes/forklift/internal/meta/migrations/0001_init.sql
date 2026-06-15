-- Initial schema for forklift metadata.

CREATE TABLE repositories (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL UNIQUE,
    format       TEXT NOT NULL,                 -- maven | npm | cargo | go | pypi
    type         TEXT NOT NULL,                 -- hosted | proxy | group (originally: local | proxy)
    upstream_url TEXT NOT NULL DEFAULT '',
    config_json  TEXT NOT NULL DEFAULT '{}',
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
);

CREATE TABLE blobs (
    sha256     TEXT PRIMARY KEY,
    size       INTEGER NOT NULL,
    ref_count  INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);

CREATE TABLE artifacts (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_id          INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    path             TEXT NOT NULL,
    version          TEXT NOT NULL DEFAULT '',
    blob_sha256      TEXT NOT NULL REFERENCES blobs(sha256),
    size             INTEGER NOT NULL,
    content_type     TEXT NOT NULL DEFAULT 'application/octet-stream',
    metadata_json    TEXT NOT NULL DEFAULT '{}',
    published_at     TEXT,                       -- upstream original release time (RFC3339)
    cached_at        TEXT NOT NULL,
    last_accessed_at TEXT NOT NULL,
    updated_at       TEXT NOT NULL,
    UNIQUE (repo_id, path)
);

CREATE INDEX idx_artifacts_repo ON artifacts(repo_id);
CREATE INDEX idx_artifacts_lru ON artifacts(repo_id, last_accessed_at);

-- Authn/Authz tables (populated from Phase 3 onward).

CREATE TABLE users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL DEFAULT '',
    source        TEXT NOT NULL DEFAULT 'local', -- local | oidc
    email         TEXT NOT NULL DEFAULT '',
    disabled      INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);

CREATE TABLE roles (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL
);

CREATE TABLE role_permissions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    role_id      INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    repo_pattern TEXT NOT NULL,                  -- glob: * or maven-*
    actions      TEXT NOT NULL                   -- csv: read,write,delete,admin
);

CREATE TABLE user_roles (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, role_id)
);

CREATE TABLE oidc_group_mappings (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    group_name TEXT NOT NULL UNIQUE,
    role_id    INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE
);

CREATE TABLE tokens (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    hash         TEXT NOT NULL UNIQUE,           -- sha256(PAT)
    scopes_json  TEXT NOT NULL DEFAULT '[]',
    expires_at   TEXT,
    last_used_at TEXT,
    created_at   TEXT NOT NULL
);

CREATE INDEX idx_tokens_user ON tokens(user_id);
