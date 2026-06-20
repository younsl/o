-- Per-repository online/offline toggle. A disabled repository keeps its config
-- and stored artifacts but stops serving the package protocols (uploads and
-- downloads return 503); the management API still works so it can be re-enabled.

ALTER TABLE repositories ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0;
