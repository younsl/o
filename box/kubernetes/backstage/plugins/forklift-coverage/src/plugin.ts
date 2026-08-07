import {
  createApiFactory,
  createPlugin,
  createRoutableExtension,
  discoveryApiRef,
  fetchApiRef,
} from '@backstage/core-plugin-api';
import { rootRouteRef } from './routes';
import { forkliftCoverageApiRef, ForkliftCoverageClient } from './api';

export const forkliftCoveragePlugin = createPlugin({
  id: 'forklift-coverage',
  routes: {
    root: rootRouteRef,
  },
  apis: [
    createApiFactory({
      api: forkliftCoverageApiRef,
      deps: {
        discoveryApi: discoveryApiRef,
        fetchApi: fetchApiRef,
      },
      factory: ({ discoveryApi, fetchApi }) =>
        new ForkliftCoverageClient({ discoveryApi, fetchApi }),
    }),
  ],
});

export const ForkliftCoveragePage = forkliftCoveragePlugin.provide(
  createRoutableExtension({
    name: 'ForkliftCoveragePage',
    component: () =>
      import('./components/ForkliftCoveragePage').then(
        m => m.ForkliftCoveragePage,
      ),
    mountPoint: rootRouteRef,
  }),
);
