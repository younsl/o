# GitLab CI/CD

Community plugin ([`@immobiliarelabs/backstage-plugin-gitlab`](https://github.com/immobiliare/backstage-plugin-gitlab)) that adds a GitLab tab to Entity pages.

## Features

| Feature | Description |
|---------|-------------|
| Pipelines | View CI/CD pipeline status and history |
| Merge Requests | List open MRs with statistics |
| Releases | Show release information |
| README | Display project README |
| Contributors | View project contributors |
| Languages | Show language breakdown |

## Configuration

```yaml
# app-config.yaml
gitlab:
  defaultCodeOwnersPath: CODEOWNERS
  defaultReadmePath: README.md
  allowedKinds:
    - Component
    - Resource
```

| Option | Default | Description |
|--------|---------|-------------|
| `defaultCodeOwnersPath` | `CODEOWNERS` | Default path for CODEOWNERS file |
| `defaultReadmePath` | `README.md` | Default path for README file |
| `allowedKinds` | `['Component']` | Entity kinds to show GitLab info |

## Entity Annotations

GitLab tab requires one of these annotations in `catalog-info.yaml`:

```yaml
metadata:
  annotations:
    # Option 1: Project ID
    gitlab.com/project-id: '12345'

    # Option 2: Project Slug
    gitlab.com/project-slug: 'group/project-name'

    # Optional: Custom README path
    gitlab.com/readme-path: 'docs/README.md'

    # Optional: Custom CODEOWNERS path
    gitlab.com/codeowners-path: '.gitlab/CODEOWNERS'
```

## Auto-fill Annotations

For entities discovered from GitLab, annotations are automatically filled by `catalogPluginGitlabFillerProcessorModule`.

Backend registration:

```typescript
// packages/backend/src/index.ts
import {
  gitlabPlugin,
  catalogPluginGitlabFillerProcessorModule,
} from '@immobiliarelabs/backstage-plugin-gitlab-backend';

backend.add(gitlabPlugin);
backend.add(catalogPluginGitlabFillerProcessorModule);
```

## Frontend Components

Available components from the plugin:

| Component | Description |
|-----------|-------------|
| `EntityGitlabContent` | Full GitLab tab content |
| `EntityGitlabPipelinesTable` | Pipelines table card |
| `EntityGitlabMergeRequestsTable` | MR table card |
| `EntityGitlabMergeRequestStatsCard` | MR statistics card |
| `EntityGitlabPeopleCard` | Contributors card |
| `EntityGitlabLanguageCard` | Languages card |
| `EntityGitlabReleasesCard` | Releases card |
| `EntityGitlabReadmeCard` | README card |

## Usage in EntityPage

```tsx
// packages/app/src/components/catalog/EntityPage.tsx
import {
  isGitlabAvailable,
  EntityGitlabContent,
  EntityGitlabReadmeCard,
} from '@immobiliarelabs/backstage-plugin-gitlab';

// Add GitLab tab to entity page
<EntityLayout.Route if={isGitlabAvailable} path="/gitlab" title="GitLab">
  <EntityGitlabContent />
</EntityLayout.Route>

// Add README card to overview (optional)
<EntitySwitch>
  <EntitySwitch.Case if={isGitlabAvailable}>
    <Grid item xs={12}>
      <EntityGitlabReadmeCard />
    </Grid>
  </EntitySwitch.Case>
</EntitySwitch>
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GITLAB_HOST` | Yes | GitLab host (e.g., `gitlab.com`) |
| `GITLAB_TOKEN` | Yes | Personal Access Token with `read_api` scope |

## Troubleshooting

### GitLab tab not showing

1. Check if entity has GitLab annotation
2. Verify `allowedKinds` includes the entity kind
3. Check browser console for errors

### API errors in GitLab tab

1. Verify `GITLAB_TOKEN` is valid and not expired
2. Check token has `read_api` scope
3. Verify `GITLAB_HOST` is correct

### README not displaying

1. Check if README file exists at configured path
2. Verify `defaultReadmePath` or `gitlab.com/readme-path` annotation
