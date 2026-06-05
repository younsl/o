import {
  createApiFactory,
  createPlugin,
  createRoutableExtension,
  discoveryApiRef,
  fetchApiRef,
} from '@backstage/core-plugin-api';
import {
  rootRouteRef,
  createAccountRouteRef,
  approvalsRouteRef,
} from './routes';
import { opensearchAccountApiRef, OpenSearchAccountClient } from './api';

export const opensearchAccountPlugin = createPlugin({
  id: 'opensearch-account',
  routes: {
    root: rootRouteRef,
    create: createAccountRouteRef,
    approvals: approvalsRouteRef,
  },
  apis: [
    createApiFactory({
      api: opensearchAccountApiRef,
      deps: {
        discoveryApi: discoveryApiRef,
        fetchApi: fetchApiRef,
      },
      factory: ({ discoveryApi, fetchApi }) =>
        new OpenSearchAccountClient({ discoveryApi, fetchApi }),
    }),
  ],
});

export const OpenSearchAccountPage = opensearchAccountPlugin.provide(
  createRoutableExtension({
    name: 'OpenSearchAccountPage',
    component: () =>
      import('./components/AccountsPage').then(m => m.AccountsPage),
    mountPoint: rootRouteRef,
  }),
);

export const OpenSearchAccountCreatePage = opensearchAccountPlugin.provide(
  createRoutableExtension({
    name: 'OpenSearchAccountCreatePage',
    component: () =>
      import('./components/CreateAccountPage').then(m => m.CreateAccountPage),
    mountPoint: createAccountRouteRef,
  }),
);

export const OpenSearchAccountApprovalsPage = opensearchAccountPlugin.provide(
  createRoutableExtension({
    name: 'OpenSearchAccountApprovalsPage',
    component: () =>
      import('./components/ApprovalsPage').then(m => m.ApprovalsPage),
    mountPoint: approvalsRouteRef,
  }),
);
