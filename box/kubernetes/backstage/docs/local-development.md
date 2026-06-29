---
plugins: []
---

# Local Development

## Purpose

This guide is for DevOps and Platform Engineers who develop and maintain this Backstage instance. It walks through setting up a local development environment so you can run and test the Backstage server on your own machine exactly as it behaves in the real deployment, before building the container image.

The versions below reflect the environment this guide was written against; newer patch releases of Node and Yarn work as long as they satisfy the constraints.

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| OS | macOS (darwin) | Linux works the same way |
| Node.js | 24.15.0 | `engines` requires `>=24.0.0` |
| Yarn | 4.12.0 (Berry) | Pinned via `packageManager`; enable with `corepack enable` |
| Docker or Podman | any recent | Only needed for the container test step |

Backstage version is pinned in `backstage.json` (currently 1.51.2). Yarn is managed by Corepack, so do not install it globally; running any `yarn` command in this directory picks up the pinned 4.12.0.

## Local configuration

Two files hold local-only settings and are git-ignored, so they never leave the machine:

- `.env` — secrets and host endpoints, loaded by the `make dev*` targets.
- `app-config.local.yaml` — local overrides merged on top of `app-config.yaml`.

The `.env` keys consumed by this instance:

```
GITLAB_TOKEN
GITLAB_HOST
KEYCLOAK_CLIENT_ID
KEYCLOAK_CLIENT_SECRET
KEYCLOAK_METADATA_URL
KEYCLOAK_CATALOG_CLIENT_SECRET
AUTH_SESSION_SECRET
SONARQUBE_BASE_URL
SONARQUBE_API_KEY
SLACK_WEBHOOK_URL
IAM_AUDIT_ASSUME_ROLE_ARN
IAM_AUDIT_SLACK_BOT_TOKEN
```

Missing keys disable the matching integration rather than crash the app, so a partial `.env` is fine for working on a single plugin.

## AWS access for IAM auditing

The `iam-user-audit` plugin reads IAM data through an assumed role. In production, EKS Pod Identity hands the pod credentials for the audit role directly. There is no Pod Identity locally, so you supply a base identity that is allowed to assume that role, which lets local runs hit IAM with the exact production permission set.

Add a named profile to `~/.aws/config` that assumes the audit role from your default credentials. Replace the account ID with your own:

```ini
[profile backstage-iam-audit]
region = ap-northeast-2
role_arn = arn:aws:iam::123456789012:role/backstage-iam-user-audit-role
source_profile = default
```

- `source_profile = default` — your everyday credentials act as the base identity, the same way the node/Pod Identity does in the cluster.
- `role_arn` — the same audit role the workload assumes in production, so you exercise the real permission boundary, not your own broader access.

Wire it into the running app one of two ways:

| Approach | `.env` / env | How credentials resolve |
|----------|--------------|-------------------------|
| Plugin assumes the role (matches production) | `IAM_AUDIT_ASSUME_ROLE_ARN=arn:aws:iam::123456789012:role/backstage-iam-user-audit-role`, run with `default` creds | `IamUserService` calls `sts:AssumeRole` on the ARN on each refresh |
| Profile assumes the role | leave `IAM_AUDIT_ASSUME_ROLE_ARN` empty, set `AWS_PROFILE=backstage-iam-audit` | the profile assumes the role; the plugin uses those credentials directly |

Verify access before starting Backstage:

```bash
aws --profile backstage-iam-audit iam list-users --max-items 1
```

Keep `iamUserAudit.dryRun: true` (the default in `app-config.yaml`) while developing, so password-reset actions are logged without calling AWS or sending Slack messages.

## Install dependencies

```bash
make init        # yarn install
```

Run this after a fresh clone, after switching branches that change `yarn.lock`, or when a plugin's dependencies change.

## Run the dev server

```bash
make dev         # frontend on :3000, backend on :7007
```

The frontend proxies API calls to the backend, so open http://localhost:3000. The target sources `.env` automatically before starting.

Variants for narrower work:

| Command | Use when |
|---------|----------|
| `make dev-local` | No GitLab integration (`DISABLE_GITLAB=true`); fastest startup |
| `make dev-backend` | Inspect backend logs in isolation (`:7007` only) |
| `make dev-frontend` | UI-only work against an already-running backend |

## Enabling guest login

Guest login skips the Keycloak round-trip, which is convenient while developing. It requires a change in both the frontend and the backend; config alone does not toggle it.

1. Frontend — add `'guest'` to the `providers` array of `CustomSignInPage` in `packages/app/src/App.tsx`:

```tsx
const CustomSignInPage = (props: any) => (
  <SignInPage
    {...props}
    auto
    providers={[
      'guest',
      {
        id: 'keycloak',
        title: 'Keycloak',
        message: 'Sign in using Keycloak',
        apiRef: keycloakOIDCAuthApiRef,
      },
    ]}
  />
);
```

2. Backend — declare the `guest` provider under `auth.providers`. With `auth.environment: development` (the default in `app-config.yaml`) it works as-is; `app-config.local.yaml` makes it explicit:

```yaml
auth:
  environment: development
  providers:
    guest:
      dangerouslyAllowOutsideDevelopment: true
```

`dangerouslyAllowOutsideDevelopment: true` is only needed when `auth.environment` is not `development` (a production-like run). Also make sure a guest user entity is resolvable; the local catalog registers `user:default/guest`.

3. Restart `make dev`. An **Enter (guest)** button appears on the sign-in page.

To disable guest login again, remove `'guest'` from the providers array and restart. The backend config alone cannot turn it off.

## Run tests

Repo-wide, across every package and plugin:

```bash
yarn backstage-cli repo test
```

A single workspace (faster while iterating on one plugin):

```bash
yarn workspace @internal/plugin-opensearch-scaling-backend test
```

Watch mode for the package you are editing:

```bash
yarn workspace <package-name> test --watch
```

## Type-check and lint

```bash
yarn tsc                          # project-wide TypeScript build
yarn backstage-cli repo lint      # lint all packages
```

Run both before pushing; the container build compiles the whole repo and will fail on type errors that the dev server tolerates.

## Container test

Validate the production image locally before pushing it. This runs the backend with the bundled frontend on a single port, backed by SQLite.

```bash
make build       # build the image (docker or podman, auto-detected)
make run         # run on :7007, mounting app-config*.yaml, templates, and .env
```

Open http://localhost:7007. `make runtime-info` shows which container runtime was detected; override with `make build CONTAINER_RUNTIME=podman`.

## Clean up

```bash
make clean       # remove node_modules, dist, and the built image
```
