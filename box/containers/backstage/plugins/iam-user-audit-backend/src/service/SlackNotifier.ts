import fetch from 'node-fetch';
import { Config } from '@backstage/config';
import { LoggerService } from '@backstage/backend-plugin-api';
import { IamUserResponse, PasswordResetRequest } from './types';

export class SlackNotifier {
  private readonly config: Config;
  private readonly logger: LoggerService;

  constructor(options: { config: Config; logger: LoggerService }) {
    this.config = options.config;
    this.logger = options.logger;
  }

  async notify(
    users: IamUserResponse[],
    inactiveDays: number,
  ): Promise<void> {
    const webhookUrl = this.config.getOptionalString(
      'iamUserAudit.slack.webhookUrl',
    );

    if (!webhookUrl) {
      this.logger.warn(
        'Slack webhook URL not configured, skipping notification',
      );
      return;
    }

    const blocks: Record<string, any>[] = [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: 'Inactive IAM Users Detected',
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${users.length}* users inactive for more than *${inactiveDays}* days`,
        },
      },
      {
        type: 'divider',
      },
    ];

    for (const user of users.slice(0, 15)) {
      const activeKeys = user.accessKeys.filter(
        k => k.status === 'Active',
      ).length;
      blocks.push({
        type: 'section',
        fields: [
          {
            type: 'mrkdwn',
            text: `*User:*\n${user.userName}`,
          },
          {
            type: 'mrkdwn',
            text: `*Inactive Days:*\n${user.inactiveDays}`,
          },
          {
            type: 'mrkdwn',
            text: `*Last Activity:*\n${user.lastActivity ?? 'Never'}`,
          },
          {
            type: 'mrkdwn',
            text: `*Access Keys:*\n${activeKeys} active / ${user.accessKeyCount} total`,
          },
        ],
      });
    }

    if (users.length > 15) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `_...and ${users.length - 15} more users_`,
        },
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
            text: `<${baseUrl}/iam-user-audit|View in Backstage>`,
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
        throw new Error(
          `Slack webhook returned ${response.status}: ${response.statusText}`,
        );
      }
    } catch (error) {
      this.logger.error(`Failed to send Slack notification: ${error}`);
      throw error;
    }
  }

  async notifyPasswordResetRequest(
    request: PasswordResetRequest,
  ): Promise<void> {
    const webhookUrl = this.config.getOptionalString(
      'iamUserAudit.slack.webhookUrl',
    );
    if (!webhookUrl) {
      this.logger.warn('[slack] webhook URL not configured, skipping password reset request notification');
      return;
    }

    this.logger.info(`[slack] Sending password reset request notification for ${request.iamUserName}`);

    const baseUrl = this.config.getString('app.baseUrl');
    const blocks: Record<string, any>[] = [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: 'Password Reset Requested',
        },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*IAM User:*\n${request.iamUserName}` },
          { type: 'mrkdwn', text: `*Requester:*\n${request.requesterRef}` },
          { type: 'mrkdwn', text: `*Reason:*\n${request.reason}` },
        ],
      },
      { type: 'divider' },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `<${baseUrl}/iam-user-audit|Review in Backstage>`,
          },
        ],
      },
    ];

    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blocks }),
      });
      if (!response.ok) {
        this.logger.warn(`[slack] Password reset request webhook returned ${response.status}`);
      } else {
        this.logger.info(`[slack] Password reset request notification sent for ${request.iamUserName}`);
      }
    } catch (error) {
      this.logger.error(`[slack] Failed to send password reset request notification: ${error}`);
    }
  }

  async notifyPasswordResetReview(
    request: PasswordResetRequest,
  ): Promise<void> {
    const webhookUrl = this.config.getOptionalString(
      'iamUserAudit.slack.webhookUrl',
    );
    if (!webhookUrl) {
      this.logger.warn('[slack] webhook URL not configured, skipping review notification');
      return;
    }

    this.logger.info(`[slack] Sending review notification for ${request.iamUserName} (${request.status})`);

    const statusEmoji = request.status === 'approved' ? ':white_check_mark:' : ':x:';
    const blocks: Record<string, any>[] = [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `Password Reset ${request.status === 'approved' ? 'Approved' : 'Rejected'}`,
        },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*IAM User:*\n${request.iamUserName}` },
          { type: 'mrkdwn', text: `*Status:*\n${statusEmoji} ${request.status}` },
          { type: 'mrkdwn', text: `*Reviewer:*\n${request.reviewerRef ?? 'unknown'}` },
        ],
      },
    ];

    if (request.reviewComment) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Comment:*\n${request.reviewComment}`,
        },
      });
    }

    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blocks }),
      });
      if (!response.ok) {
        this.logger.warn(`[slack] Review webhook returned ${response.status}`);
      } else {
        this.logger.info(`[slack] Review notification sent for ${request.iamUserName} (${request.status})`);
      }
    } catch (error) {
      this.logger.error(`[slack] Failed to send review notification: ${error}`);
    }
  }

  async sendPasswordDm(
    email: string,
    iamUserName: string,
    newPassword: string,
    requestId: string,
    reviewerRef: string,
  ): Promise<void> {
    const botToken = this.config.getOptionalString(
      'iamUserAudit.slack.botToken',
    );
    if (!botToken) {
      this.logger.warn(
        '[slack] bot token not configured, skipping password DM',
      );
      return;
    }

    this.logger.info(`[slack] Sending password DM to ${email} for IAM user ${iamUserName}`);

    try {
      // Lookup Slack user by email
      const lookupRes = await fetch(
        `https://slack.com/api/users.lookupByEmail?email=${encodeURIComponent(email)}`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${botToken}` },
        },
      );
      const lookupData = (await lookupRes.json()) as {
        ok: boolean;
        user?: { id: string };
        error?: string;
      };

      if (!lookupData.ok || !lookupData.user) {
        this.logger.warn(
          `[slack] User lookup failed for ${email}: ${lookupData.error ?? 'no user returned'}`,
        );
        return;
      }

      const slackUserId = lookupData.user.id;

      // Send DM via chat.postMessage (channel = user ID opens DM automatically)
      const baseUrl = this.config.getString('app.baseUrl');
      const blocks: Record<string, any>[] = [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: 'Password Reset Completed',
          },
        },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: `*Request ID:*\n${requestId}` },
            { type: 'mrkdwn', text: `*IAM User:*\n${iamUserName}` },
            { type: 'mrkdwn', text: `*Approved by:*\n${reviewerRef}` },
            { type: 'mrkdwn', text: `*Temporary Password:*\n\`${newPassword}\`` },
          ],
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: ':warning: You must change your password on first login.',
            },
          ],
        },
        { type: 'divider' },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `<${baseUrl}/iam-user-audit|View in Backstage>`,
            },
          ],
        },
      ];

      const postRes = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${botToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          channel: slackUserId,
          text: `Password reset completed for IAM user ${iamUserName}`,
          blocks,
        }),
      });
      const postData = (await postRes.json()) as {
        ok: boolean;
        error?: string;
      };

      if (!postData.ok) {
        this.logger.warn(
          `[slack] DM delivery failed for ${email}: ${postData.error}`,
        );
        return;
      }

      this.logger.info(`[slack] Password DM sent to ${email} for IAM user ${iamUserName}`);
    } catch (error) {
      this.logger.error(`[slack] Failed to send password DM to ${email}: ${error}`);
    }
  }
}
