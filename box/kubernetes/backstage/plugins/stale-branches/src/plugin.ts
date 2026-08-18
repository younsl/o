import {
  createApiFactory,
  createPlugin,
  createRoutableExtension,
  discoveryApiRef,
  fetchApiRef,
} from '@backstage/core-plugin-api';
import { rootRouteRef } from './routes';
import { staleBranchesApiRef, StaleBranchesClient } from './api';

export const staleBranchesPlugin = createPlugin({
  id: 'stale-branches',
  routes: {
    root: rootRouteRef,
  },
  apis: [
    createApiFactory({
      api: staleBranchesApiRef,
      deps: {
        discoveryApi: discoveryApiRef,
        fetchApi: fetchApiRef,
      },
      factory: ({ discoveryApi, fetchApi }) =>
        new StaleBranchesClient({ discoveryApi, fetchApi }),
    }),
  ],
});

export const StaleBranchesPage = staleBranchesPlugin.provide(
  createRoutableExtension({
    name: 'StaleBranchesPage',
    component: () =>
      import('./components/StaleBranchesPage').then(m => m.StaleBranchesPage),
    mountPoint: rootRouteRef,
  }),
);
