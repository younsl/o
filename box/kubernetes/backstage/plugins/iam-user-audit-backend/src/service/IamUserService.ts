import {
  IAMClient,
  ListUsersCommand,
  ListAccessKeysCommand,
  GetAccessKeyLastUsedCommand,
  GetLoginProfileCommand,
  UpdateLoginProfileCommand,
} from '@aws-sdk/client-iam';
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import { Config } from '@backstage/config';
import { LoggerService } from '@backstage/backend-plugin-api';
import { IamUserResponse, AccessKeyInfo } from './types';

export class IamUserService {
  private client: IAMClient;
  private readonly config: Config;
  private readonly logger: LoggerService;
  private credentialExpiry: Date | null = null;

  constructor(options: { config: Config; logger: LoggerService }) {
    this.config = options.config;
    this.logger = options.logger;
    const region =
      options.config.getOptionalString('iamUserAudit.region') ?? 'us-east-1';
    this.client = new IAMClient({ region });
  }

  private async refreshClient(): Promise<void> {
    const assumeRoleArn = this.config.getOptionalString(
      'iamUserAudit.assumeRoleArn',
    );
    if (!assumeRoleArn) {
      this.logger.debug('No assumeRoleArn configured, using default credentials');
      return;
    }

    // Reuse credentials if not yet expired (5 min buffer)
    if (
      this.credentialExpiry &&
      this.credentialExpiry.getTime() - Date.now() > 5 * 60 * 1000
    ) {
      this.logger.debug(
        `Reusing assumed role credentials (expires ${this.credentialExpiry.toISOString()})`,
      );
      return;
    }

    this.logger.info(`Attempting to assume role: ${assumeRoleArn}`);

    const region =
      this.config.getOptionalString('iamUserAudit.region') ?? 'us-east-1';
    const sts = new STSClient({ region });
    const response = await sts.send(
      new AssumeRoleCommand({
        RoleArn: assumeRoleArn,
        RoleSessionName: 'backstage-iam-user-audit',
        DurationSeconds: 3600,
      }),
    );

    const creds = response.Credentials!;
    this.client = new IAMClient({
      region,
      credentials: {
        accessKeyId: creds.AccessKeyId!,
        secretAccessKey: creds.SecretAccessKey!,
        sessionToken: creds.SessionToken!,
      },
    });
    this.credentialExpiry = creds.Expiration ?? null;
    this.logger.info(
      `Successfully assumed role: ${assumeRoleArn} (expires ${this.credentialExpiry?.toISOString()})`,
    );
  }

  async listUsers(): Promise<IamUserResponse[]> {
    await this.refreshClient();
    const allUsers = await this.listAllIamUsers();
    const now = new Date();
    const results: IamUserResponse[] = [];

    for (const user of allUsers) {
      try {
        const accessKeys = await this.getAccessKeysForUser(user.UserName!);
        const hasConsoleAccess = await this.hasLoginProfile(user.UserName!);

        const activityDates: Date[] = [];

        if (user.PasswordLastUsed) {
          activityDates.push(user.PasswordLastUsed);
        }

        for (const key of accessKeys) {
          if (key.lastUsedDate) {
            activityDates.push(new Date(key.lastUsedDate));
          }
        }

        const lastActivity =
          activityDates.length > 0
            ? new Date(Math.max(...activityDates.map(d => d.getTime())))
            : null;

        const referenceDate = lastActivity ?? user.CreateDate!;
        const diffMs = now.getTime() - referenceDate.getTime();
        const inactive = Math.floor(diffMs / (24 * 60 * 60 * 1000));

        results.push({
          userName: user.UserName!,
          userId: user.UserId!,
          arn: user.Arn!,
          createDate: user.CreateDate!.toISOString(),
          passwordLastUsed: user.PasswordLastUsed?.toISOString() ?? null,
          lastActivity: lastActivity?.toISOString() ?? null,
          inactiveDays: inactive,
          accessKeyCount: accessKeys.length,
          hasConsoleAccess,
          accessKeys,
        });
      } catch (error) {
        this.logger.warn(
          `Failed to process user ${user.UserName}: ${error}`,
        );
      }
    }

    return results.sort((a, b) => b.inactiveDays - a.inactiveDays);
  }

  private async listAllIamUsers() {
    const users: any[] = [];
    let marker: string | undefined;

    do {
      const command = new ListUsersCommand({
        Marker: marker,
        MaxItems: 100,
      });
      const response = await this.client.send(command);
      users.push(...(response.Users ?? []));
      marker = response.IsTruncated ? response.Marker : undefined;
    } while (marker);

    return users;
  }

  private async getAccessKeysForUser(
    userName: string,
  ): Promise<AccessKeyInfo[]> {
    const command = new ListAccessKeysCommand({ UserName: userName });
    const response = await this.client.send(command);
    const keys: AccessKeyInfo[] = [];

    for (const meta of response.AccessKeyMetadata ?? []) {
      let lastUsedDate: string | null = null;
      let lastUsedService: string | null = null;

      try {
        const lastUsedCommand = new GetAccessKeyLastUsedCommand({
          AccessKeyId: meta.AccessKeyId!,
        });
        const lastUsedResponse = await this.client.send(lastUsedCommand);
        const info = lastUsedResponse.AccessKeyLastUsed;
        if (info?.LastUsedDate) {
          lastUsedDate = info.LastUsedDate.toISOString();
          lastUsedService = info.ServiceName ?? null;
        }
      } catch {
        // ignore — key might be new or access denied
      }

      keys.push({
        accessKeyId: meta.AccessKeyId!,
        status: meta.Status ?? 'Unknown',
        lastUsedDate,
        lastUsedService,
      });
    }

    return keys;
  }

  async resetLoginProfile(
    userName: string,
    newPassword: string,
  ): Promise<void> {
    await this.refreshClient();
    await this.client.send(
      new UpdateLoginProfileCommand({
        UserName: userName,
        Password: newPassword,
        PasswordResetRequired: true,
      }),
    );
    this.logger.info(`Reset login profile for user: ${userName}`);
  }

  private async hasLoginProfile(userName: string): Promise<boolean> {
    try {
      await this.client.send(
        new GetLoginProfileCommand({ UserName: userName }),
      );
      return true;
    } catch {
      return false;
    }
  }
}
