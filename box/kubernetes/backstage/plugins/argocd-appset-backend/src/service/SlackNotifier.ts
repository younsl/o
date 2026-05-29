import fetch from 'node-fetch';
import { Config } from '@backstage/config';
import { LoggerService } from '@backstage/backend-plugin-api';
import { ApplicationSetResponse } from './types';

export class SlackNotifier {
  private readonly config: Config;
  private readonly logger: LoggerService;

  constructor(options: { config: Config; logger: LoggerService }) {
    this.config = options.config;
    this.logger = options.logger;
  }

  async notify(appSets: ApplicationSetResponse[], totalCount: number): Promise<void> {
    const webhookUrl = this.config.getOptionalString(
      'argocdApplicationSet.slack.webhookUrl',
    );

    if (!webhookUrl) {
      this.logger.warn('Slack webhook URL not configured, skipping notification');
      return;
    }

    const blocks: Record<string, any>[] = [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: 'Non-HEAD revision(s) detected',
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${appSets.length}* of *${totalCount}* ApplicationSets are not targeting HEAD.`,
        },
      },
      {
        type: 'divider',
      },
    ];

    for (const appSet of appSets) {
      blocks.push({
        type: 'section',
        fields: [
          {
            type: 'mrkdwn',
            text: `*Name:*\n${appSet.name}`,
          },
          {
            type: 'mrkdwn',
            text: `*Namespace:*\n${appSet.namespace}`,
          },
          {
            type: 'mrkdwn',
            text: `*Target Revision:*\n${appSet.targetRevisions.join(', ')}`,
          },
          {
            type: 'mrkdwn',
            text: `*Applications:*\n${appSet.applications.join(', ') || `${appSet.applicationCount}`}`,
          },
        ],
      });
    }

    const baseUrl = this.config.getString('app.baseUrl');
    blocks.push(
      { type: 'divider' },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `<${baseUrl}/argocd-appset|View in Backstage>`,
          },
        ],
      },
    );

    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blocks }),
      });

      if (!response.ok) {
        throw new Error(`Slack webhook returned ${response.status}: ${response.statusText}`);
      }
    } catch (error) {
      this.logger.error(`Failed to send Slack notification: ${error}`);
      throw error;
    }
  }
}
