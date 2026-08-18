---
plugins:
  - stale-branches
  - stale-branches-backend
---

# Stale Branches

Custom plugin that reports GitLab branches nobody has pushed to for longer than
a configured threshold, on a schedule, with the result posted to Slack.

It replaces a GitLab CI scheduled shell job that did the same thing with curl,
jq, and three CI/CD variables.

## Model

The plugin is shaped like Airflow: one connection, many schedules, and a run
record for every execution.

| Concept | Holds | Scope |
| --- | --- | --- |
| Connection | GitLab API URL and token | One per instance |
| Schedule | Projects, threshold, ignore list, Slack webhook, cron, timezone | Many |
| Run | State, counts, duration, and the branches that run found | Many per schedule |

The credential is instance wide for the same reason Airflow keeps connections
apart from DAGs: duplicating it per schedule would mean rotating a token in as
many places as there are scans.

## Main page

The schedule list is the landing page. Each row carries a pause toggle, the
owner, the run history as one square per run, the cron, the last run, and the
next run.

- Squares read left to right in time order, so the right hand edge is always
  the newest run. Green is a success, red a failure, a pulsing blue one is in
  flight, and a hollow one is a dry run. Hovering or focusing a square opens a
  card with the run's start time in the schedule's zone, who triggered it, how
  long it took, and what it found. Clicking one opens the schedule on that run.
- Owner is whoever registered the schedule. On a narrow viewport the next run
  drops first, then the owner: both are recoverable from the cron and the edit
  form, and the columns that carry a verdict are not.
- A paused schedule keeps its history and its last verdict, dimmed, with no
  next run. Pausing is one PATCH, so the toggle never has to submit a form.
- Above the list sit only the facts the rows cannot carry: the estate-wide
  stale total, the oldest branch, and the age distribution as one banded bar.
  Schedule counts, per-schedule totals and run outcomes are already in the pause
  toggle, the last-run cell and the run strip of each row, so the overview does
  not repeat them.
- `New schedule` sits top right. Creating is a deliberate step, so the list
  never doubles as a form.

## Schedule page

Opening a schedule shows its run history beside the result of the selected run,
and the branch table underneath. Picking an older run re-reads what that run
found rather than what the newest one would report, since each run stores its
own result.

| URL | Opens |
| --- | --- |
| `/stale-branches` | Schedule list and overview |
| `/stale-branches/new` | Create form |
| `/stale-branches/schedules/<id>` | Schedule, newest run |
| `/stale-branches/schedules/<id>?run=<runId>` | Schedule, one specific run |
| `/stale-branches/schedules/<id>?age=90` | Branch table filtered to 90d and older |
| `/stale-branches/schedules/<id>/edit` | Edit form |
| `/stale-branches/connection` | GitLab connection |

## Creating a schedule

The form asks for three things: a name, the projects, and how often it runs.
Everything else has a working default and sits under `Advanced`, which opens
itself when editing a schedule whose values differ from the defaults, so a saved
value is never hidden behind a collapsed section.

The interval is a cron expression and a timezone, nothing else. The expression
is resolved as it is typed and answers with its next three fire times, since one
timestamp does not say whether a cron repeats the way its author meant. An
expression the scheduler would reject blocks the save rather than turning into a
schedule that never fires. The timezone is picked from a list and defaults to
the browser's own.

Under the fields, a sentence reads back what the form adds up to, in the words
the schedule page will use, so the effect of a change is visible without saving
to find out.

## Configuration

Everything is entered in the UI, so changing a project list, a token, or a cron
needs no redeploy and no Helm values change.

| Setting | Meaning |
| --- | --- |
| API URL | GitLab API root, for example `https://gitlab.example.com/api/v4` |
| Token | Personal, group, or project token with `read_api` |
| Projects | One `group/name` per line. A bare name matches every project with that name |
| Threshold in days | A branch is stale when its newest commit is older than this |
| Never stale | Branch names that never count, on top of the default branch |
| Skip protected branches | Extends the skip to every branch GitLab marks protected |
| Webhook URL | Slack incoming webhook this schedule posts to |
| Webhook description | Where the report lands, for example `#devops-alerts` |
| Active | Paused keeps the schedule and its history, but nothing fires |
| Cron | Standard five-field expression, resolved as it is typed |
| Timezone | IANA zone the cron is read in |

The connection form runs two checks as it is filled in, and marks each with a
tick once it passes.

| Check | Asks | Needs a token |
| --- | --- | --- |
| Endpoint | Does anything answer at this URL, how fast, and does it answer like a GitLab API | No |
| Credential | Does this token work, and whose is it | Yes |

Reachability calls `GET /version`, which a GitLab API answers with 401 rather
than 404 when unauthenticated, so an unauthorised reply is the healthy one: it
proves an API is listening and only the credential is missing. Splitting the two
means a URL typed into an otherwise empty form is verified straight away instead
of staying silent until a token exists. Both checks must pass before the
connection can be saved, so a wrong token is reported as a configuration error
rather than as an empty run.
The token and the webhook URL are write only: they are stored as written, shown
back masked, and an empty field on save keeps the stored value. Every Slack
webhook masks to the same origin, so the webhook description is what names the
destination on the schedule page and in the form summary.

Nothing for this plugin is set in `app-config.yaml` beyond the
`app.plugins.staleBranches` on/off switch every plugin here has. With no
connection saved in the UI, the credentials fall back to the first entry in
`integrations.gitlab`, which is what a Backstage instance already talking to
this GitLab has.

`staleBranches.apiBaseUrl` and `staleBranches.token` are read if present, and
exist for the one case `integrations.gitlab` cannot cover: pointing the scan at
a different GitLab than the catalog uses. They are not in `app-config.yaml`
because they need no editing to run. The database takes precedence over both,
and a token that came from config is never copied into the database, where it
would outlive the config it was read from.

## What counts as stale

GitLab exposes no branch creation time. The scan reads `commit.committed_date`
on the branch tip, so the age is time since the last push, not time since the
branch was opened. A branch opened a year ago and committed to yesterday is not
stale.

The default branch is always skipped. Everything in the never-stale list is
skipped by name, and protected branches are skipped unless the toggle is off.

## Notifications

One message per stale branch, so it can be forwarded to whoever has to act on
it. Repetition is handled by the dedupe log rather than by batching.

```
:warning: *2주가 지난 브랜치 알림* :warning:
프로젝트: <https://gitlab.example.com/platform/admin-web/-/branches|platform/admin-web>
브랜치명: *<https://gitlab.example.com/platform/admin-web/-/tree/feature/EX-142|feature/EX-142>*
생성일: *2025-01-15 09:12:44*
생성자: *gildong.hong*
생성자 이메일: *gildong.hong@example.com*
이 브랜치는 생성일로부터 2주가 지났습니다.
```

- The threshold is written the way it is set: `2주가` for a multiple of seven
  days, `10일이` otherwise. The particle rides along with the number, since
  Korean picks it by the final consonant of the word before it.
- Both names are links, so a cleanup starts from the word that names the thing
  rather than from a URL line. `브랜치명` opens the branch itself, `프로젝트`
  opens the branch list it lives in, which is where a branch gets deleted.
- `프로젝트` carries the full `group/name` path. Two groups can hold a project
  called the same thing, and the bare name does not say which one is meant.
- `생성일` is the tip commit time in the schedule's timezone. The shell job this
  replaces truncated it to its date part first, so every message it sent
  claimed midnight.
- Messages are paced about a second apart, since Slack throttles an incoming
  webhook and a first run can carry dozens of branches.

### Dry run

`Dry run` on a schedule page scans and records a run like any other, but sends
nothing and leaves the dedupe log untouched, so a new schedule can be checked
against real projects without putting anything in front of a team. The run
stores what it *would* have sent, and the UI never shows that number without
saying which it is. Dry runs are drawn hollow in the run history so they are
never mistaken for a run that reported something. Scheduled runs are never dry.

A branch is reported once per tip commit per schedule, so two schedules watching
the same project with different thresholds do not silence each other. Each
record is written right after its own message lands, so a failure part way
through neither loses what was delivered nor marks as delivered what was not.
`Clear notification history` makes the next send report the full backlog again.

## Access

Any signed-in Backstage user can read the overview, the schedule list, a
schedule, and its runs. The following are restricted to entries in
`permission.admins`.

| Action | Endpoint |
| --- | --- |
| Create, edit, delete a schedule | `POST/PUT/DELETE /schedules[/:id]` |
| Pause or resume a schedule | `PATCH /schedules/:id/enabled` |
| Trigger a run, real or dry | `POST /schedules/:id/trigger` |
| Send the Slack report | `POST /schedules/:id/notify` |
| Clear the notification history | `POST /schedules/:id/notify/reset` |
| Read or change the connection | `GET /connection`, `PUT /connection` |
| Verify credentials | `POST /connection/test` |
| Check endpoint reachability | `POST /connection/reachability` |
| Resolve a cron expression | `POST /cron/preview` |

## Schedule execution

Backstage's scheduler cron is UTC only, and every schedule carries its own
expression and zone, so one task ticks every minute and each schedule is gated
against its own cron. A wall-clock cron such as `0 10 * * 1-5` fires at 10:00 in
the configured zone. Schedules are read on each tick, so one created in the UI
starts firing without a restart.

A run only leaves the `running` state from the process that started it, so any
run still marked running at boot is marked failed instead of hanging forever.

## Storage

| Table | Holds |
| --- | --- |
| `stale_branches_connection` | One row with the GitLab API URL and token |
| `stale_branches_schedules` | One row per registered schedule |
| `stale_branches_runs` | One row per run, with the branches it found and whether it was a dry run. 100 kept per schedule |
| `stale_branches_notified` | One row per reported branch and tip commit, pruned after 180 days |
