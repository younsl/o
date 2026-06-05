import { createRouteRef } from '@backstage/core-plugin-api';

export const rootRouteRef = createRouteRef({
  id: 'opensearch-account',
});

export const createAccountRouteRef = createRouteRef({
  id: 'opensearch-account-create',
});

export const approvalsRouteRef = createRouteRef({
  id: 'opensearch-account-approvals',
});
