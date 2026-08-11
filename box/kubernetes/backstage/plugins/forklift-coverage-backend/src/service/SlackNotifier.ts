import fetch from 'node-fetch';
import { Config } from '@backstage/config';
import { LoggerService } from '@backstage/backend-plugin-api';
import { CoverageResponse, ForkliftProject, WebhookConfig } from './types';

/** Slack rejects very long messages, so the list is capped. */
const MAX_LISTED_PROJECTS = 50;

export function readWebhookFromConfig(config: Config): WebhookConfig | null {
  // Empty strings are a valid placeholder in app-config, and Backstage throws
  // on them when a string is expected, so read the raw value.
  const raw = config.getOptional('forkliftCoverage.webhook.url');
  const url = typeof raw === 'string' ? raw.trim() : '';
  if (!url) return null;
  return {
    url,
    enabled:
      config.getOptionalBoolean('forkliftCoverage.webhook.enabled') ?? true,
  };
}

function percent(value: number, total: number): string {
  if (total === 0) return '-';
  return `${((value * 100) / total).toFixed(1)}%`;
}

function projectLink(webBaseUrl: string | null, path: string): string {
  if (!webBaseUrl) return path;
  return `<${webBaseUrl}/${path}|${path}>`;
}

export function buildSummaryText(
  coverage: CoverageResponse,
  notApplied: ForkliftProject[],
): string {
  const lines: string[] = [];
  // The title links back to the page that produced the report, which is also
  // how a reader can tell which Backstage sent it. It lands on the not applied
  // filter rather than the whole table, so the screen matches what the message
  // is about. Partial projects are listed below but sit behind their own chip,
  // since the table filters on one status at a time.
  const pageUrl = coverage.backstageUrl
    ? `${coverage.backstageUrl}/forklift-coverage/list?status=no`
    : null;
  lines.push(
    pageUrl
      ? `*<${pageUrl}|Forklift Coverage Report>*`
      : '*Forklift Coverage Report*',
  );
  // Coverage is the number people act on, so it gets its own line instead of
  // being buried mid-sentence in the breakdown.
  lines.push(`Coverage ${percent(coverage.applied, coverage.target)}`);
  lines.push(
    `Target (has GitLab CI) ${coverage.target} / applied ${coverage.applied} / partial ${coverage.partial} / not applied ${coverage.notApplied} / scan errors ${coverage.errored}`,
  );
  lines.push(`Out of scope (no CI) ${coverage.skipped}`);

  if (notApplied.length > 0) {
    lines.push('');
    lines.push(`*Not fully applied, ${notApplied.length} projects*`);
    const shown = notApplied.slice(0, MAX_LISTED_PROJECTS);
    shown.forEach((project, index) => {
      const suffix = project.applied === 'partial' ? ' (partial)' : '';
      lines.push(
        `${index + 1}. ${projectLink(coverage.gitlabWebUrl, project.path)}${suffix}`,
      );
    });
    // The cut is where a reader most needs a way out, so the pointer carries
    // the link instead of only naming the page.
    const remaining = notApplied.length - shown.length;
    if (remaining > 0) {
      lines.push(
        pageUrl
          ? `_${remaining} more, see <${pageUrl}|the Forklift Coverage page>_`
          : `_${remaining} more, see the Forklift Coverage page_`,
      );
    }
  }

  return lines.join('\n');
}

/**
 * Same renderer, fed made-up numbers. Used by the setup wizard so an admin can
 * see the message shape before the first scan has produced any data.
 */
export function buildSampleSummaryText(coverage: CoverageResponse): string {
  const sample: CoverageResponse = {
    ...coverage,
    target: 56,
    applied: 36,
    partial: 1,
    notApplied: 19,
    errored: 0,
    skipped: 18,
  };
  const example = (path: string, applied: 'no' | 'partial'): ForkliftProject => ({
    id: 0,
    path,
    group: path.split('/')[0] ?? '',
    name: path.split('/').pop() ?? path,
    webUrl: '',
    defaultBranch: 'main',
    topics: [],
    applied,
    branch: null,
    onDefault: null,
    format: null,
    ciWired: applied === 'partial',
    registryPinned: false,
    evidence: [],
    note: null,
    skipped: false,
    lastActivityAt: '',
    excludeReason: null,
  });
  return buildSummaryText(sample, [
    example('payments/checkout-api', 'no'),
    example('platform/notification-worker', 'no'),
    example('data/etl-batch', 'partial'),
  ]);
}

export class SlackNotifier {
  private readonly logger: LoggerService;

  constructor(options: { logger: LoggerService }) {
    this.logger = options.logger;
  }

  async send(webhookUrl: string, text: string): Promise<void> {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Every link already carries its own label, so an unfurl card would only
      // repeat it. The Backstage links need a session anyway, which Slack does
      // not have, so it has nothing to preview.
      body: JSON.stringify({ text, unfurl_links: false }),
      timeout: 15_000,
    } as any);
    if (!res.ok) {
      const body = (await res.text()).slice(0, 512).trim();
      throw new Error(`Slack webhook returned ${res.status}: ${body}`);
    }
    this.logger.info('[forklift-coverage] slack summary sent');
  }
}
