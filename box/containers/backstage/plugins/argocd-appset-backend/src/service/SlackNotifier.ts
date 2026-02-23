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

  async notify(appSets: ApplicationSetResponse[]): Promise<void> {
    const webhookUrl = this.config.getOptionalString(
      'argocdApplicationSet.slack.webhookUrl',
    );

    if (!webhookUrl) {
      this.logger.warn('Slack webhook URL not configured, skipping notification');
      return;
    }

    const blocks = [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `ArgoCD ApplicationSet: ${appSets.length} non-HEAD revision(s) detected`,
        },
      },
      {
        type: 'divider',
      },
      ...appSets.map(appSet => ({
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
            text: `*Applications:*\n${appSet.applicationCount}`,
          },
        ],
      })),
    ];

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
