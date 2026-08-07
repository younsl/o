---
plugins:
  - forklift-coverage
  - forklift-coverage-backend
---

# Forklift Coverage

Custom plugin that reports how far the Forklift artifact repository has been
adopted across GitLab projects that have CI.

## Features

- Org-wide coverage percentage with applied, partial, not applied, scan error, and out of scope counts
- Project table with the branch, repository format, and the exact files that prove the wiring
- Group breakdown so a team can see its own adoption at a glance
- 90 day coverage trend chart backed by one snapshot per scan
- Scheduled scan that posts a summary and the not applied list to Slack, plus a manual send
- Pipeline viewer for administrators that renders GitLab CI files only, never application source
- Repository owners can opt out with a GitLab topic, without a change to this repository
- Setup wizard for the Forklift host, the Slack webhook, and the scan schedule, with the host verified before it is saved

## Access

Any signed-in Backstage user can read the coverage page, the group breakdown,
the trend, and a project detail page. The following are restricted to entries
in `permission.admins`.

| Action | Endpoint |
| --- | --- |
| Trigger a scan | `POST /scan` |
| Send the Slack summary | `POST /notify` |
| View pipeline definitions | `GET /projects/:path/pipeline` |
| Read or change settings | `GET /settings`, `PUT /settings` |

Until a Forklift host is set, the page shows the setup wizard to an
administrator and a wait-for-an-admin notice to everyone else.

## Verdict

The scan reads two kinds of file on each branch it visits.

| Signal | Matched files |
| --- | --- |
| `ciWired` | `.gitlab-ci.yml` and its variants, plus `ci/*.yml` |
| `registryPinned` | `.npmrc`, `.yarnrc`, `package.json`, `settings.xml`, `pom.xml`, Gradle files, `pip.conf`, `requirements*.txt`, `pyproject.toml`, `Dockerfile*` |

A file counts as evidence when it contains the configured Forklift host or a
`FORKLIFT_*TOKEN` variable reference.

| Verdict | Meaning |
| --- | --- |
| `yes` | Both signals present. The pipeline actually pulls through Forklift |
| `partial` | Only one signal present |
| `no` | The project has CI but no Forklift reference anywhere the scan looked |
| `error` | A GitLab API call failed, so the project is not counted as covered or uncovered |
| out of scope | No GitLab CI file on any branch, so the project was never an integration target |

Vendored paths (`node_modules`, `vendor`, `dist`, `build/generated`) are
skipped, and a README that merely mentions Forklift is not evidence.

## Scan order

The default branch is checked first. When nothing is found there, the remaining
branches are visited newest commit first, and the walk stops as soon as one
branch shows the wiring. `onDefault: false` therefore means the integration
exists on a feature branch and has not merged yet.

Branches older than `sinceDays` are ignored, and at most `maxBranches`
non-default branches are visited per project. A project that hits the cap
carries a `branches_truncated` note.

## Exclusions

Two mechanisms exist, and the topic is the preferred one.

- Add the `forklift.excluded` topic under **Settings > General > Topics** in
  the repository. Nothing in Backstage needs to change, and the opt out stays
  visible to the repository owners.
- List the project in `forkliftCoverage.scope.exclude` when a topic cannot be
  added, for example a vendor delivered repository. An entry matches the
  project name or the full path exactly.

Excluded projects are listed at the bottom of the page with their reason.

## Configuration

Nothing is required in app-config or in the Helm chart. The first administrator
to open the page gets a setup wizard for the Forklift host, the Slack webhook,
and the scan schedule, and those values are stored in the database.

Every key below is an optional override for teams that prefer config over the
wizard. A value stored through the wizard wins over app-config.

| Key | Default |
| --- | --- |
| `forkliftHost` | none, the wizard asks for it |
| `scope.group` | every project the token can see |
| `scope.exclude` | `[]` |
| `scope.excludeTopics` | `[forklift.excluded]` |
| `scan.concurrency` | `8` |
| `scan.rps` | `20` |
| `scan.retries` | `3` |
| `scan.cooldownSeconds` | `30` |
| `scan.maxBranches` | `10` |
| `scan.sinceDays` | `180` |
| `scan.useSearch` | `false` |
| `schedule.cron` | `0 10 * * 1-5` |
| `schedule.timezone` | `UTC` |
| `schedule.enabled` | `true` |
| `schedule.scanOnStart` | `true`, and only when no scan is stored yet |
| `webhook.url` | unset, notifications disabled |
| `webhook.enabled` | `true` when a URL is set |

Pinning `forkliftCoverage.forkliftHost` in app-config makes it the fallback the
wizard reports as managed by config.

The GitLab host, API base URL, and token come from `integrations.gitlab[0]`.
The token needs `read_api`, and it decides which projects are visible: the scan
lists projects the token is a member of.

`scan.useSearch` turns on the blob search fast path for the default branch. It
needs Elasticsearch on the GitLab instance and runs on a much lower rate limit
than the plain API, so it stays off by default.

The host is probed with a plain `GET https://<host>/` before a save is
accepted. Any HTTP status counts as reachable, including 401 and 404, since an
artifact repository may refuse an anonymous root request while being healthy.
Only a transport failure or timeout blocks the save.

## Endpoints

| Method | Path | Description |
| --- | --- | --- |
| GET | `/coverage` | Summary counts, every scanned project, excluded list, scan state |
| GET | `/coverage/groups` | Per group coverage, lowest first |
| GET | `/coverage/history?days=90` | Coverage snapshots for the trend chart |
| GET | `/projects/:path` | One project from the last scan |
| GET | `/projects/:path/pipeline?ref=` | GitLab CI files of one ref, admin only |
| POST | `/scan` | Start a scan in the background, admin only |
| POST | `/notify/preview` | Render the Slack message without sending it, admin only |
| POST | `/notify` | Send the Slack summary now, admin only |
| GET | `/settings` | Effective settings with the webhook URL masked, admin only |
| POST | `/settings/test` | Probe a candidate host without saving, admin only |
| PUT | `/settings` | Save host, webhook, and schedule, admin only |

## Storage

`forklift_coverage_settings` holds the single row of runtime settings written
by the wizard. `forklift_coverage_history` holds one row per scan with the target, applied,
partial, not applied, and skipped counts. Rows older than 365 days are purged
on write. Project level results live in memory only and are rebuilt by the next
scan.
