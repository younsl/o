import { CatalogApi } from '@backstage/catalog-client';
import { parseEntityRef, stringifyEntityRef } from '@backstage/catalog-model';
import { AuthService, LoggerService } from '@backstage/backend-plugin-api';
import { Config } from '@backstage/config';
import { IamUserResponse } from './types';

export const IAM_USER_OWNER_TAG_KEY =
  'iam-user-audit.plugins.backstage.io/owner';

export type SlackRecipientSource =
  | 'owner-tag'
  | 'iam-user-name'
  | 'email-domain';

export interface SlackRecipientResolution {
  email: string;
  source: SlackRecipientSource;
  ownerRef?: string;
}

export interface IamUserIdentity {
  userRef: string;
  ownershipEntityRefs: string[];
}

export function normalizeOwnerRef(value: string): string | null {
  const raw = value.trim();
  if (!raw) return null;

  try {
    return stringifyEntityRef(
      parseEntityRef(raw, {
        defaultKind: 'user',
        defaultNamespace: 'default',
      }),
    );
  } catch {
    return null;
  }
}

export function canManageIamUser(
  user: Pick<IamUserResponse, 'ownerRef'>,
  identity: IamUserIdentity,
): boolean {
  if (!user.ownerRef) return false;

  const normalizedOwner = normalizeOwnerRef(user.ownerRef);
  if (!normalizedOwner) return false;

  const ownershipRefs = new Set(
    [identity.userRef, ...identity.ownershipEntityRefs]
      .map(ref => normalizeOwnerRef(ref))
      .filter((ref): ref is string => Boolean(ref)),
  );

  return ownershipRefs.has(normalizedOwner);
}

function deriveFallbackEmail(
  config: Config,
  userName: string,
): SlackRecipientResolution {
  if (userName.includes('@')) {
    return { email: userName, source: 'iam-user-name' };
  }

  const emailDomain =
    config.getOptionalString('iamUserAudit.slack.emailDomain')?.trim() ?? '';
  if (emailDomain) {
    return { email: `${userName}@${emailDomain}`, source: 'email-domain' };
  }

  return { email: userName, source: 'iam-user-name' };
}

export class IamUserOwnerResolver {
  private readonly auth: AuthService;
  private readonly catalogClient: CatalogApi;
  private readonly config: Config;
  private readonly logger: LoggerService;

  constructor(options: {
    auth: AuthService;
    catalogClient: CatalogApi;
    config: Config;
    logger: LoggerService;
  }) {
    this.auth = options.auth;
    this.catalogClient = options.catalogClient;
    this.config = options.config;
    this.logger = options.logger;
  }

  async resolveSlackRecipient(
    user: Pick<IamUserResponse, 'userName' | 'ownerRef'>,
  ): Promise<SlackRecipientResolution> {
    const ownerRef = user.ownerRef ? normalizeOwnerRef(user.ownerRef) : null;
    if (ownerRef) {
      const email = await this.resolveOwnerEmail(ownerRef);
      if (email) {
        return { email, source: 'owner-tag', ownerRef };
      }
      this.logger.warn(
        `[iam-owner] Owner ${ownerRef} has no resolvable profile email; falling back to IAM user ${user.userName}`,
      );
    }

    return deriveFallbackEmail(this.config, user.userName);
  }

  private async resolveOwnerEmail(ownerRef: string): Promise<string | null> {
    const parsed = parseEntityRef(ownerRef);
    if (parsed.kind.toLocaleLowerCase('en-US') !== 'user') {
      this.logger.warn(
        `[iam-owner] Owner ${ownerRef} is not a User entity; Slack DM fallback will be used`,
      );
      return null;
    }

    try {
      const { token } = await this.auth.getPluginRequestToken({
        onBehalfOf: await this.auth.getOwnServiceCredentials(),
        targetPluginId: 'catalog',
      });
      const entity = await this.catalogClient.getEntityByRef(ownerRef, {
        token,
      });
      const profile = entity?.spec?.profile;
      if (
        profile &&
        typeof profile === 'object' &&
        !Array.isArray(profile) &&
        typeof profile.email === 'string' &&
        profile.email.trim()
      ) {
        return profile.email.trim();
      }
    } catch (error) {
      this.logger.warn(
        `[iam-owner] Failed to resolve owner ${ownerRef} email from catalog: ${error}`,
      );
    }

    return null;
  }
}
