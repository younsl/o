import fetch from 'node-fetch';
import { Config } from '@backstage/config';
import { LoggerService } from '@backstage/backend-plugin-api';
import { GitlabToken } from './types';

interface NotifierOptions {
  logger: LoggerService;
  config: Config;
}

export class WebhookNotifier {
  private readonly logger: LoggerService;
  private readonly config: Config;
  private readonly timezone: string;

  constructor(options: NotifierOptions) {
    this.logger = options.logger;
    this.config = options.config;
    this.timezone =
      options.config.getOptionalString('gitlabTokenAudit.schedule.timezone') ??
      'UTC';
  }

  /**
   * Send a single-token expiring notification. Matches IAM Audit's Slack
   * Block Kit template — works with Slack Incoming Webhooks and any other
   * receiver that ignores unknown top-level fields (we include both a `blocks`
   * payload and a structured `event` field).
   */
  async send(
    url: string,
    payload: {
      token: GitlabToken;
      threshold: number;
      daysUntilExpiry: number;
    },
  ): Promise<void> {
    const body = this.buildSinglePayload(payload);
    await this.post(url, body);
    this.logger.info(
      `[gitlab-token-audit] webhook sent for ${payload.token.kind}/${payload.token.id} threshold=${payload.threshold}d`,
    );
  }

  /**
   * Send a bulk expiring notification for a set of tokens (used by manual
   * trigger). Slack Block Kit format with per-token fields.
   */
  async sendBulk(
    url: string,
    tokens: GitlabToken[],
    options: { trigger: 'manual' | 'scheduled'; reason?: string; actorRef?: string },
  ): Promise<void> {
    if (tokens.length === 0) return;
    const body = this.buildBulkPayload(tokens, options);
    await this.post(url, body);
    this.logger.info(
      `[gitlab-token-audit] bulk webhook sent: ${tokens.length} tokens trigger=${options.trigger} actor=${options.actorRef ?? 'system'}`,
    );
  }

  private async post(url: string, body: Record<string, unknown>): Promise<void> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `Webhook POST failed: ${res.status} ${res.statusText} ${text.slice(0, 200)}`,
      );
    }
  }

  buildSinglePreview(payload: {
    token: GitlabToken;
    threshold: number;
    daysUntilExpiry: number;
  }): Record<string, unknown> {
    return this.buildSinglePayload(payload);
  }

  buildBulkPreview(
    tokens: GitlabToken[],
    options: { trigger: 'manual' | 'scheduled'; reason?: string; actorRef?: string },
  ): Record<string, unknown> {
    return this.buildBulkPayload(tokens, options);
  }

  private buildSinglePayload(payload: {
    token: GitlabToken;
    threshold: number;
    daysUntilExpiry: number;
  }): Record<string, unknown> {
    const { token, threshold, daysUntilExpiry } = payload;
    const ownerLabel = this.ownerLabel(token);

    const blocks: Record<string, any>[] = [
      {
        type: 'header',
        text: { type: 'plain_text', text: 'GitLab Token Expiring' },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `Token *${token.name}* expires in *${daysUntilExpiry}* day${daysUntilExpiry === 1 ? '' : 's'} (threshold *${threshold}d*).`,
        },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Kind:*\n${this.kindLabel(token.kind)}` },
          { type: 'mrkdwn', text: `*Owner:*\n${ownerLabel}` },
          {
            type: 'mrkdwn',
            text: `*Expires:*\n${
              token.expiresAt ? this.formatDateOnly(token.expiresAt) : 'No expiry'
            }`,
          },
          {
            type: 'mrkdwn',
            text: `*Created:*\n${this.formatDateTime(token.createdAt)}`,
          },
          {
            type: 'mrkdwn',
            text: `*Last Used:*\n${this.formatDateTime(token.lastUsedAt)}`,
          },
          { type: 'mrkdwn', text: `*State:*\n${token.state}` },
          {
            type: 'mrkdwn',
            text: `*Scopes:*\n${token.scopes.length ? token.scopes.join(', ') : '—'}`,
          },
        ],
      },
    ];

    if (token.webUrl) {
      blocks.push({
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Open in GitLab' },
            url: token.webUrl,
          },
        ],
      });
    }

    this.appendFooter(blocks);

    return {
      text: `GitLab token "${token.name}" expires in ${daysUntilExpiry} day(s)`,
      blocks,
      event: 'gitlab_token_expiring',
      threshold,
      daysUntilExpiry,
      token: this.tokenForJson(token),
    };
  }

  private buildBulkPayload(
    tokens: GitlabToken[],
    options: { trigger: 'manual' | 'scheduled'; reason?: string; actorRef?: string },
  ): Record<string, unknown> {
    const triggerLabel = options.trigger === 'manual' ? 'Manual trigger' : 'Scheduled scan';
    const blocks: Record<string, any>[] = [
      {
        type: 'header',
        text: { type: 'plain_text', text: 'GitLab Tokens Expiring' },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${tokens.length}* token${tokens.length === 1 ? '' : 's'} require attention — ${triggerLabel}${options.actorRef ? ` by *${options.actorRef}*` : ''}.${options.reason ? `\n_Reason:_ ${options.reason}` : ''}`,
        },
      },
      { type: 'divider' },
    ];

    for (const token of tokens.slice(0, 15)) {
      const daysLabel =
        token.daysUntilExpiry === null
          ? 'No expiry'
          : token.daysUntilExpiry < 0
          ? `Expired ${Math.abs(token.daysUntilExpiry)}d ago`
          : `${token.daysUntilExpiry}d remaining`;

      const nameText = token.webUrl
        ? `<${token.webUrl}|${token.name}>`
        : token.name;
      blocks.push({
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Token:*\n${nameText}` },
          { type: 'mrkdwn', text: `*Owner:*\n${this.ownerLabel(token)}` },
          {
            type: 'mrkdwn',
            text: `*Expires:*\n${
              token.expiresAt ? this.formatDateOnly(token.expiresAt) : '—'
            }`,
          },
          {
            type: 'mrkdwn',
            text: `*Created:*\n${this.formatDateTime(token.createdAt)}`,
          },
          { type: 'mrkdwn', text: `*Remaining:*\n${daysLabel}` },
        ],
      });
    }

    if (tokens.length > 15) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `_...and ${tokens.length - 15} more token${tokens.length - 15 === 1 ? '' : 's'}_`,
        },
      });
    }

    this.appendFooter(blocks);

    return {
      text: `${tokens.length} GitLab token(s) require attention`,
      blocks,
      event: 'gitlab_tokens_expiring_bulk',
      trigger: options.trigger,
      actorRef: options.actorRef ?? null,
      reason: options.reason ?? null,
      tokens: tokens.map(t => this.tokenForJson(t)),
    };
  }

  private appendFooter(blocks: Record<string, any>[]): void {
    const baseUrl = this.config.getOptionalString('app.baseUrl');
    if (!baseUrl) return;
    blocks.push(
      { type: 'divider' },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `<${baseUrl}/gitlab-token-audit|View in Backstage>`,
          },
        ],
      },
    );
  }

  private ownerLabel(token: GitlabToken): string {
    if (token.kind === 'personal') {
      if (token.userName) return `@${token.userName}`;
      if (token.userId) return `user #${token.userId}`;
      return '—';
    }
    return token.ownerScope ?? '—';
  }

  /** GitLab `expires_at` is date-only; display as 'YYYY-MM-DD (TZ)'. */
  private formatDateOnly(iso: string | null): string {
    if (!iso) return '—';
    return `${iso.slice(0, 10)} (${this.tzLabel()})`;
  }

  /** Full datetime fields rendered in the configured timezone with offset. */
  private formatDateTime(iso: string | null): string {
    if (!iso) return '—';
    try {
      const parts = new Intl.DateTimeFormat('sv-SE', {
        timeZone: this.timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(new Date(iso));
      return `${parts} ${this.tzLabel()}`;
    } catch {
      return iso;
    }
  }

  private tzLabel(): string {
    // IANA name like 'Asia/Seoul' is unambiguous and short enough to display.
    return this.timezone;
  }

  private kindLabel(kind: GitlabToken['kind']): string {
    switch (kind) {
      case 'personal':
        return 'Personal Access Token';
      case 'project':
        return 'Project Access Token';
      case 'group':
        return 'Group Access Token';
    }
  }

  private tokenForJson(token: GitlabToken): Record<string, unknown> {
    return {
      id: token.id,
      kind: token.kind,
      name: token.name,
      userId: token.userId ?? null,
      userName: token.userName ?? null,
      ownerScope: token.ownerScope ?? null,
      scopes: token.scopes,
      expiresAt: token.expiresAt,
      createdAt: token.createdAt,
      lastUsedAt: token.lastUsedAt,
      state: token.state,
      daysUntilExpiry: token.daysUntilExpiry,
    };
  }
}
