import fetch from 'node-fetch';
import { LoggerService } from '@backstage/backend-plugin-api';
import { StaleBranch } from './types';

/**
 * `YYYY-MM-DD HH:MM:SS` in the schedule's own timezone.
 *
 * The shell job this replaces truncated the timestamp to its date part before
 * reformatting it, so every message claimed midnight. The clock time is kept
 * here, and the zone is the schedule's rather than the server's, so the date
 * matches the one the reader would see in GitLab.
 */
function formatCommitTime(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(iso));
  const get = (type: string) =>
    parts.find(part => part.type === type)?.value ?? '00';
  // `hour: '2-digit'` with hour12 false renders midnight as 24 in some engines.
  const hour = get('hour') === '24' ? '00' : get('hour');
  return `${get('year')}-${get('month')}-${get('day')} ${hour}:${get('minute')}:${get('second')}`;
}

/**
 * The threshold as a subject phrase: `2주가` for a multiple of seven days,
 * `10일이` otherwise.
 *
 * The particle is part of the return value because Korean picks it by the
 * final consonant of the word before it. `주` has none and takes 가, `일` ends
 * in ㄹ and takes 이, so a fixed particle is wrong for one of the two.
 */
export function formatThresholdSubject(days: number): string {
  return days % 7 === 0 ? `${days / 7}주가` : `${days}일이`;
}

export interface BranchMessageOptions {
  branch: StaleBranch;
  thresholdDays: number;
  /** The schedule's zone, which the commit timestamp is rendered in. */
  timezone: string;
}

/**
 * One message per stale branch, in the shape the team already reads.
 *
 * A message names a single branch and its author, so it can be forwarded to
 * whoever has to act on it. Repetition is handled upstream instead of by
 * batching: a branch is reported once per tip commit, so a run only posts what
 * nobody has seen yet.
 */
export function buildBranchText(options: BranchMessageOptions): string {
  const { branch, thresholdDays, timezone } = options;
  const threshold = formatThresholdSubject(thresholdDays);
  return [
    // The title names what the message is about, not how old the branch is:
    // the threshold is per schedule, so it belonged in the sentence that
    // states it rather than in a heading that changed shape with it.
    `:warning: *Stale Branch 알림* :warning:  `,
    // The name carries its own link, so the branch list is one click from the
    // word that names it rather than a bare URL on a line of its own. The full
    // path, not the bare name: two groups can hold a project called the same
    // thing, and the name alone does not say which one is meant.
    `프로젝트: <${branch.projectBranchesUrl}|${branch.projectPath}> `,
    // The branch name links to the branch itself, the project name to the list
    // it lives in. A cleanup starts at one of those two, so both are one click
    // from the words that name them rather than from a URL line.
    `브랜치명: *<${branch.webUrl}|${branch.name}>*`,
    `생성일: *${formatCommitTime(branch.lastCommitAt, timezone)}*`,
    `생성자: *${branch.authorName}*`,
    `생성자 이메일: *${branch.authorEmail}*`,
    `이 브랜치는 생성일로부터 ${threshold} 지났습니다.`,
  ].join('\n');
}

/**
 * The same renderer fed a made-up branch, so the form can show the message
 * shape before the schedule has ever run.
 */
export function buildSampleBranchText(options: {
  thresholdDays: number;
  timezone: string;
}): string {
  return buildBranchText({
    thresholdDays: options.thresholdDays,
    timezone: options.timezone,
    branch: {
      projectId: 0,
      projectName: 'checkout-api',
      projectPath: 'payments/checkout-api',
      projectWebUrl: 'https://gitlab.example.com/payments/checkout-api',
      projectBranchesUrl:
        'https://gitlab.example.com/payments/checkout-api/-/branches',
      name: 'feature/EX-142',
      webUrl:
        'https://gitlab.example.com/payments/checkout-api/-/tree/feature/EX-142',
      lastCommitAt: new Date(
        Date.now() - options.thresholdDays * 86_400_000,
      ).toISOString(),
      ageDays: options.thresholdDays,
      authorName: 'jane',
      authorEmail: 'jane@example.com',
      isProtected: false,
      merged: false,
    },
  });
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
      // The project URL is the only link, and it needs no card to be read, so
      // an unfurl would only make each message taller.
      body: JSON.stringify({ text, unfurl_links: false }),
      timeout: 15_000,
    } as any);
    if (!res.ok) {
      const body = (await res.text()).slice(0, 512).trim();
      throw new Error(`Slack webhook returned ${res.status}: ${body}`);
    }
    this.logger.info('[stale-branches] slack message sent');
  }
}
