import { createPermission } from '@backstage/plugin-permission-common';

/**
 * ArgoCD Appset: Mute/Unmute permission (admin only)
 */
export const argocdAppsetMutePermission = createPermission({
  name: 'argocd.appset.mute',
  attributes: { action: 'update' },
});

/**
 * IAM User Audit: Password Reset review (approve/reject) permission (admin only)
 */
export const iamPasswordResetReviewPermission = createPermission({
  name: 'iam.password-reset.review',
  attributes: { action: 'update' },
});
