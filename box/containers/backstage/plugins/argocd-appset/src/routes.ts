import { createRouteRef, createSubRouteRef } from '@backstage/core-plugin-api';

export const rootRouteRef = createRouteRef({
  id: 'argocd-appset',
});

export const auditLogRouteRef = createSubRouteRef({
  id: 'argocd-appset/audit-log',
  parent: rootRouteRef,
  path: '/audit-logs/:namespace/:name',
});
