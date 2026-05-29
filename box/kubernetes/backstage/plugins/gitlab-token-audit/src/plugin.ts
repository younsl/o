import {
  createApiFactory,
  createPlugin,
  createRoutableExtension,
  discoveryApiRef,
  fetchApiRef,
} from '@backstage/core-plugin-api';
import { rootRouteRef } from './routes';
import { gitlabTokenAuditApiRef, GitlabTokenAuditClient } from './api';

export const gitlabTokenAuditPlugin = createPlugin({
  id: 'gitlab-token-audit',
  routes: {
    root: rootRouteRef,
  },
  apis: [
    createApiFactory({
      api: gitlabTokenAuditApiRef,
      deps: {
        discoveryApi: discoveryApiRef,
        fetchApi: fetchApiRef,
      },
      factory: ({ discoveryApi, fetchApi }) =>
        new GitlabTokenAuditClient({ discoveryApi, fetchApi }),
    }),
  ],
});

export const GitlabTokenAuditPage = gitlabTokenAuditPlugin.provide(
  createRoutableExtension({
    name: 'GitlabTokenAuditPage',
    component: () =>
      import('./components/GitlabTokenAuditPage').then(
        m => m.GitlabTokenAuditPage,
      ),
    mountPoint: rootRouteRef,
  }),
);
