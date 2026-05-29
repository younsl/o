import {
  createApiFactory,
  createPlugin,
  createRoutableExtension,
  discoveryApiRef,
  fetchApiRef,
} from '@backstage/core-plugin-api';
import { rootRouteRef } from './routes';
import { iamUserAuditApiRef, IamUserAuditClient } from './api';

export const iamUserAuditPlugin = createPlugin({
  id: 'iam-user-audit',
  routes: {
    root: rootRouteRef,
  },
  apis: [
    createApiFactory({
      api: iamUserAuditApiRef,
      deps: {
        discoveryApi: discoveryApiRef,
        fetchApi: fetchApiRef,
      },
      factory: ({ discoveryApi, fetchApi }) =>
        new IamUserAuditClient({ discoveryApi, fetchApi }),
    }),
  ],
});

export const IamUserAuditPage = iamUserAuditPlugin.provide(
  createRoutableExtension({
    name: 'IamUserAuditPage',
    component: () =>
      import('./components/IamUserAuditPage').then(m => m.IamUserAuditPage),
    mountPoint: rootRouteRef,
  }),
);
