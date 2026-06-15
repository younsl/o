-- Rename the repository type "local" to "hosted" to match Nexus terminology
-- (hosted | proxy | group). User accounts keep source = 'local'; that column
-- is a different concept (local vs oidc identity) and is not touched.

UPDATE repositories SET type = 'hosted' WHERE type = 'local';
