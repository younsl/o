# CLAUDE.md

## Changelog Is Mandatory On Release

Bumping `org.opencontainers.image.version` in the `Dockerfile` publishes a new image tag, so every commit that touches that label must also add the matching entry to `docs/changelog.md` in the same commit. There is no separate release-notes step and no CI check that catches a missing entry, so an omitted entry is silently lost.

Entry rules:
- Heading is the image tag (`## 1.53.1-1`), never the Backstage version. Rebuilds at the same base version differ only by suffix.
- First line states the release date and the Backstage base version, linked to its upstream release tag.
- Also update the version references in `README.md` (badge), `docs/local-development.md`, and the image tag in `values.yaml`.

## Async Initialization Pattern

Classes requiring async initialization (DB seed, schema setup) must use the **factory pattern** (`static async create()`) since constructors cannot be `async`.

```
static async create()    → object creation + async init (DB seed, etc.)
private constructor()    → sync field assignment only
registerTasks()          → schedule registration only
each task                → data collection/validation/aggregation only
```

**Rules**:
- Never mix initialization logic into `registerTasks()` or scheduled task handlers
- Scheduled tasks must not depend on execution order of other tasks
- Reference: `OpenCostCostStore.create()`, `OpenCostCollector.create()`
