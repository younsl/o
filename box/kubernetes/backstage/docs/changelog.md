# Changelog

## Overview

This document records the release history of the `ghcr.io/younsl/backstage` image so operators can tell what changed between two tags before rolling an upgrade. Use it to decide whether a tag carries a Backstage base upgrade, a plugin or dependency change, or only a rebuild, and to trace when a behavior first appeared in the deployed image.

The container registry keeps the tags but not the reasons behind them, and the Backstage upstream release notes cover only the base version, not the in-house plugins and configuration in this repository. This file is the only place both are written down together.

Headings are image tags, not Backstage versions. A rebuild at the same Backstage version increments the suffix (`1.53.0-1` to `1.53.0-2`), so the suffix is part of the release identity. Bumping `org.opencontainers.image.version` in the `Dockerfile` is what publishes a tag.

Tags released before this file existed (`1.51.0-1` through `1.53.0-3`) are not recorded here.

## 1.53.1-1

Released 2026-08-09. Built on Backstage [v1.53.1](https://github.com/backstage/backstage/releases/tag/v1.53.1) as the base version. Rebuilt 2026-08-11 at the same tag, so an image pulled before that date does not carry the Forklift Coverage changes at the end of this list.

- Added the `platforms-backend` plugin, which records a visit each time someone opens a platform from the Platforms page and serves per-platform visitor stats. The Platforms page now shows a rank, a week-over-week trend, and daily and weekly visitor counts, inline on each card and in the hover tooltip in grid view. Tags on a card became buttons that toggle the page's tag filter. The plugin needs no app-config entry and is always on.
- Upgraded Backstage from 1.53.0 to 1.53.1. Errors in TypeScript configuration schema definitions no longer prevent the app from building or starting and are logged as warnings instead.
- Bumped `@backstage/backend-defaults` from 0.17.5 to 0.17.6 in `packages/backend`, `plugins/grafana-dashboard-map-backend`, and `plugins/openapi-registry-backend`.
- No create-app template changes in this release.
- Corrected the image tag in `values.yaml`, which still pointed at `1.52.1-2`.
- Forklift Coverage: every view has its own URL, so a pasted link opens the same view for the next reader. The list view keeps its status filter and search text in the query string, `/forklift-coverage` redirects to the list, and an unknown suffix redirects there too rather than dead-ending.
- Forklift Coverage: the setup page disables Send now while a scan is running and shows live counts beside the button, since a report sent mid-scan would list half-counted projects.
- Forklift Coverage: the timezone field became a searchable picker built from the browser's IANA zone list, with the current UTC offset in each label. A typo used to be rejected as an invalid cron expression, which named the wrong field.
