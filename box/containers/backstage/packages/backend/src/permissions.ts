import { createPermission } from '@backstage/plugin-permission-common';

export const argocdAppsetMutePermission = createPermission({
  name: 'argocd.appset.mute',
  attributes: { action: 'update' },
});

export const iamPasswordResetReviewPermission = createPermission({
  name: 'iam.password-reset.review',
  attributes: { action: 'update' },
});
