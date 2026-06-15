-- Declarative RBAC: mark rows owned by the chart-provided policy so the
-- reconciler can authoritatively sync them on startup without disturbing rows
-- created interactively through the UI/API (managed = 0).

ALTER TABLE roles ADD COLUMN managed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE role_permissions ADD COLUMN managed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE user_roles ADD COLUMN managed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE oidc_group_mappings ADD COLUMN managed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN managed INTEGER NOT NULL DEFAULT 0;
