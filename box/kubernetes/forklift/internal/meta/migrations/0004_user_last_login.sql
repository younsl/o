-- Track the most recent interactive login (local password or OIDC) per user.
-- Empty string means the user has never logged in.
ALTER TABLE users ADD COLUMN last_login_at TEXT NOT NULL DEFAULT '';
