-- Record the last version observed in a blocked request for a pending approval.
-- The approval decision unit stays the whole package (age policy and version
-- denies gate individual versions); this column is display-only, surfacing which
-- version a client tried so reviewers have context in the queue. Empty when the
-- demand came from a metadata request that carries no version (npm/pypi), or
-- from a format whose request path has no version component.

ALTER TABLE package_approvals ADD COLUMN last_requested_version TEXT NOT NULL DEFAULT '';
