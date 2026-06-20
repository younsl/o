-- Per-user account lockout after repeated failed password attempts. Opt-in per
-- user (lockout_enabled); failed_login_count tracks consecutive local-password
-- failures and resets on success; locked_at is set when the count crosses the
-- threshold (empty means not locked). The default/bootstrap admin is never
-- locked, enforced in the auth layer, so it can always recover access.

ALTER TABLE users ADD COLUMN lockout_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN failed_login_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN locked_at TEXT NOT NULL DEFAULT '';
