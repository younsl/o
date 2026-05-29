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

  async healthCheck(): Promise<{
    webhook: { configured: boolean };
    bot: { configured: boolean; valid: boolean; botName?: string; teamName?: string };
    checkedAt: string;
  }> {
    const webhookUrl = this.config.getOptionalString('iamUserAudit.slack.webhookUrl');
    const botToken = this.config.getOptionalString('iamUserAudit.slack.botToken');

    const result = {
      webhook: { configured: !!webhookUrl },
      bot: { configured: !!botToken, valid: false } as {
        configured: boolean;
        valid: boolean;
        botName?: string;
        teamName?: string;
      },
      checkedAt: new Date().toISOString(),
    };

    if (botToken) {
      try {
        const res = await fetch('https://slack.com/api/auth.test', {
          method: 'POST',
          headers: { Authorization: `Bearer ${botToken}` },
        });
        const data = (await res.json()) as {
          ok: boolean;
          user?: string;
          team?: string;
        };
        if (data.ok) {
          result.bot.valid = true;
          result.bot.botName = data.user;
          result.bot.teamName = data.team;
        }
      } catch {
        // leave valid as false
      }
    }

    return result;
  }

  async checkSlackUser(email: string): Promise<boolean> {
    const info = await this.lookupSlackUser(email);
    return info !== null;
  }

  async lookupSlackUser(email: string): Promise<{
    id: string;
    realName: string;
    displayName: string;
    title: string;
    image48: string;
    email: string;
  } | null> {
    const botToken = this.config.getOptionalString(
      'iamUserAudit.slack.botToken',
    );
    if (!botToken) return null;

    try {
      const res = await fetch(
        `https://slack.com/api/users.lookupByEmail?email=${encodeURIComponent(email)}`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${botToken}` },
        },
      );
      const data = (await res.json()) as {
        ok: boolean;
        user?: {
          id: string;
          real_name?: string;
          profile?: {
            display_name?: string;
            title?: string;
            image_48?: string;
            email?: string;
          };
        };
      };
      if (!data.ok || !data.user) return null;
      const u = data.user;
      return {
        id: u.id,
        realName: u.real_name ?? '',
        displayName: u.profile?.display_name ?? '',
        title: u.profile?.title ?? '',
        image48: u.profile?.image_48 ?? '',
        email: u.profile?.email ?? email,
      };
    } catch {
      return null;
    }
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
          { type: 'mrkdwn', text: `*Request ID:*\n${request.id}` },
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
          { type: 'mrkdwn', text: `*Request ID:*\n${request.id}` },
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

  async sendStatusDm(
    email: string,
    user: IamUserResponse,
    inactiveDays: number,
    senderRef: string,
    message: string,
  ): Promise<void> {
    const botToken = this.config.getOptionalString(
      'iamUserAudit.slack.botToken',
    );
    if (!botToken) {
      throw new Error('Slack bot token not configured');
    }

    this.logger.info(`[slack] Sending status DM to ${email} for IAM user ${user.userName}`);

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
      throw new Error(
        `Slack user lookup failed for ${email}: ${lookupData.error ?? 'no user returned'}`,
      );
    }

    const slackUserId = lookupData.user.id;
    const baseUrl = this.config.getString('app.baseUrl');
    const activeKeys = user.accessKeys.filter(k => k.status === 'Active').length;
    const blocks: Record<string, any>[] = [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: 'IAM User Status Notification',
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: message,
        },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*User:*\n${user.userName}` },
          { type: 'mrkdwn', text: `*Inactive Days:*\n${inactiveDays}` },
          { type: 'mrkdwn', text: `*Last Activity:*\n${user.lastActivity ?? 'Never'}` },
          { type: 'mrkdwn', text: `*Active Keys:*\n${activeKeys} / ${user.accessKeyCount}` },
          { type: 'mrkdwn', text: `*Console Access:*\n${user.hasConsoleAccess ? 'Enabled' : 'Disabled'}` },
        ],
      },
      { type: 'divider' },
      {
        type: 'context',
        elements: [
          { type: 'mrkdwn', text: senderRef === 'system' ? 'Automatically sent by Backstage IAM User Audit' : `Sent by ${senderRef}` },
        ],
      },
      {
        type: 'context',
        elements: [
          { type: 'mrkdwn', text: `<${baseUrl}/iam-user-audit|View in Backstage>` },
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
        text: `IAM User Status Notification for ${user.userName}`,
        blocks,
      }),
    });
    const postData = (await postRes.json()) as {
      ok: boolean;
      error?: string;
    };

    if (!postData.ok) {
      throw new Error(`Slack DM delivery failed for ${email}: ${postData.error}`);
    }

    this.logger.info(`[slack] Status DM sent to ${email} for IAM user ${user.userName}`);
  }

  async sendRejectionDm(
    email: string,
    iamUserName: string,
    requestId: string,
    reviewerRef: string,
    comment?: string,
  ): Promise<void> {
    const botToken = this.config.getOptionalString(
      'iamUserAudit.slack.botToken',
    );
    if (!botToken) {
      this.logger.warn(
        '[slack] bot token not configured, skipping rejection DM',
      );
      return;
    }

    this.logger.info(`[slack] Sending rejection DM to ${email} for IAM user ${iamUserName}`);

    try {
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
      const baseUrl = this.config.getString('app.baseUrl');
      const blocks: Record<string, any>[] = [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: 'Password Reset Rejected',
          },
        },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: `*Request ID:*\n${requestId}` },
            { type: 'mrkdwn', text: `*IAM User:*\n${iamUserName}` },
            { type: 'mrkdwn', text: `*Rejected by:*\n${reviewerRef}` },
          ],
        },
      ];

      if (comment) {
        blocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Reason:*\n${comment}`,
          },
        });
      }

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

      const postRes = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${botToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          channel: slackUserId,
          text: `Password reset rejected for IAM user ${iamUserName}`,
          blocks,
        }),
      });
      const postData = (await postRes.json()) as {
        ok: boolean;
        error?: string;
      };

      if (!postData.ok) {
        this.logger.warn(
          `[slack] Rejection DM delivery failed for ${email}: ${postData.error}`,
        );
        return;
      }

      this.logger.info(`[slack] Rejection DM sent to ${email} for IAM user ${iamUserName}`);
    } catch (error) {
      this.logger.error(`[slack] Failed to send rejection DM to ${email}: ${error}`);
    }
  }
}
