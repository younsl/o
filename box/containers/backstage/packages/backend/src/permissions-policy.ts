import {
  createBackendModule,
  coreServices,
} from '@backstage/backend-plugin-api';
import { policyExtensionPoint } from '@backstage/plugin-permission-node/alpha';
import {
  PermissionPolicy,
  PolicyQuery,
  PolicyQueryUser,
} from '@backstage/plugin-permission-node';
import {
  AuthorizeResult,
  PolicyDecision,
} from '@backstage/plugin-permission-common';

const ADMIN_PERMISSIONS = [
  'argocd.appset.mute',
  'iam.password-reset.review',
];

class AdminOnlyPolicy implements PermissionPolicy {
  private readonly admins: string[];

  constructor(admins: string[]) {
    this.admins = admins;
  }

  async handle(
    request: PolicyQuery,
    user?: PolicyQueryUser,
  ): Promise<PolicyDecision> {
    if (ADMIN_PERMISSIONS.includes(request.permission.name)) {
      const userRef = user?.info.userEntityRef;
      if (userRef && this.admins.includes(userRef)) {
        return { result: AuthorizeResult.ALLOW };
      }
      return { result: AuthorizeResult.DENY };
    }

    // All other permissions: allow (preserve existing behavior)
    return { result: AuthorizeResult.ALLOW };
  }
}

export const permissionModuleAdminPolicy = createBackendModule({
  pluginId: 'permission',
  moduleId: 'admin-policy',
  register(reg) {
    reg.registerInit({
      deps: {
        policy: policyExtensionPoint,
        config: coreServices.rootConfig,
      },
      async init({ policy, config }) {
        const admins =
          config.getOptionalStringArray('permission.admins') ?? [];
        policy.setPolicy(new AdminOnlyPolicy(admins));
      },
    });
  },
});
