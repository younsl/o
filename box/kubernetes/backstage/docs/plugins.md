# Plugins

## Overview

Inventory of plugins enabled in this Backstage instance, grouped by source. Use it to identify where each feature comes from (official / community / in-house) and to scope upgrades.

## Background

### Plugin sources

| Type | Meaning | Upgrade policy |
|------|---------|----------------|
| **Native** | First-party packages under `@backstage/*`, maintained by Spotify alongside Backstage core. | Bumped together via `backstage-cli versions:bump`. |
| **Community** | Third-party packages such as `@backstage-community/*` or `@immobiliarelabs/*`. Independent release cycles; may lag behind core. | Upgraded per package after reading the changelog. |
| **Custom** | In-house plugins under this repo's `plugins/*` workspace, referenced as `workspace:*`. | Modified by PRs in this repo. |

### Frontend design system

New custom plugins are written against [`@backstage/ui`](https://www.npmjs.com/package/@backstage/ui) (BUI) — Backstage's CSS-first design system that replaces the Material UI dependency, exposing tokens via `--bui-*` CSS variables. Some legacy code and most native/community plugins still use Material UI v4, so the migration is incremental. Progress is shown under **Settings → Build Info**.

### Frontend/backend plugin pairs

Most custom plugins ship as `<name>` (frontend) plus `<name>-backend` (backend). The backend is registered in `packages/backend/src/index.ts` via `backend.add(import('@internal/plugin-<name>-backend'))`, and the frontend is mounted from `packages/app/src/App.tsx`.

## Inventory

### Native

| Feature | Plugin | Description |
|---------|--------|-------------|
| Home Dashboard | [`@backstage/plugin-home`](https://www.npmjs.com/package/@backstage/plugin-home) | Home page with search autocomplete, quick links, starred/owned entities |
| GitLab Auto Discovery | [`@backstage/plugin-catalog-backend-module-gitlab`](https://www.npmjs.com/package/@backstage/plugin-catalog-backend-module-gitlab) | Auto-discover `catalog-info.yaml` from GitLab repos |
| GitLab Org Sync | [`@backstage/plugin-catalog-backend-module-gitlab-org`](https://www.npmjs.com/package/@backstage/plugin-catalog-backend-module-gitlab-org) | Sync GitLab groups/users to Backstage |
| OIDC Authentication | [`@backstage/plugin-auth-backend-module-oidc-provider`](https://www.npmjs.com/package/@backstage/plugin-auth-backend-module-oidc-provider) | Keycloak/OIDC SSO authentication |
| API Docs | [`@backstage/plugin-api-docs`](https://www.npmjs.com/package/@backstage/plugin-api-docs) | OpenAPI, AsyncAPI, GraphQL spec viewer |
| TechDocs | [`@backstage/plugin-techdocs`](https://www.npmjs.com/package/@backstage/plugin-techdocs) | Markdown-based technical documentation |
| Scaffolder | [`@backstage/plugin-scaffolder`](https://www.npmjs.com/package/@backstage/plugin-scaffolder) | Template-based project creation |
| Search | [`@backstage/plugin-search`](https://www.npmjs.com/package/@backstage/plugin-search) | Full-text search across catalog |

### Community

| Feature | Plugin | Description |
|---------|--------|-------------|
| GitLab CI/CD | [`@immobiliarelabs/backstage-plugin-gitlab`](https://www.npmjs.com/package/@immobiliarelabs/backstage-plugin-gitlab) | View pipelines, MRs, releases, README on Entity page |
| SonarQube | [`@backstage-community/plugin-sonarqube`](https://www.npmjs.com/package/@backstage-community/plugin-sonarqube) | Code quality metrics with auto annotation injection |
| Simple Icons | [`@dweber019/backstage-plugin-simple-icons`](https://www.npmjs.com/package/@dweber019/backstage-plugin-simple-icons) | Brand icons from [simpleicons.org](https://simpleicons.org/) |

### Custom

| Feature | Plugin | Description |
|---------|--------|-------------|
| Platforms | — | Internal platform services link cards with search and tag filtering |
| OpenAPI Registry | `openapi-registry` | Register external OpenAPI specs by URL with search and filters |
| ArgoCD AppSets | `argocd-appset` | View/manage ArgoCD ApplicationSets with mute/unmute, Slack alerts, audit log |
| IAM User Audit | `iam-user-audit` | AWS IAM inactive user monitoring with password reset and Slack DM |
| Kafka Topic | `kafka-topic` | Self-service Kafka topic creation with in-app approval workflow |
| Catalog Health | `catalog-health` | Track `catalog-info.yaml` coverage across GitLab projects |
| OpenCost | `opencost` | Multi-cluster Kubernetes cost visualization |
| S3 Log Extract | `s3-log-extract` | S3-based Java log extraction with approval workflow |
| Grafana Dashboard Map | `grafana-dashboard-map` | Map Grafana dashboards onto a system architecture diagram |
| GitLab Token Audit | `gitlab-token-audit` | Audit GitLab personal/project/group access tokens with expiry alerts via Slack webhook |
| OpenSearch | `opensearch-account` | Self-service OpenSearch Security internal user create/list/delete/modify with admin approval, RBAC, and audit trail |
| Build Info | — | Settings page showing build metadata, installed plugins, BUI migration progress |
