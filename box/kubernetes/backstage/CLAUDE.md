# CLAUDE.md

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
