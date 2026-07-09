import {
  createApiFactory,
  createPlugin,
  createRoutableExtension,
  discoveryApiRef,
  fetchApiRef,
} from '@backstage/core-plugin-api';
import { rootRouteRef } from './routes';
import { opensearchViewerApiRef, OpenSearchViewerClient } from './api';

export const opensearchViewerPlugin = createPlugin({
  id: 'opensearch-viewer',
  routes: {
    root: rootRouteRef,
  },
  apis: [
    createApiFactory({
      api: opensearchViewerApiRef,
      deps: {
        discoveryApi: discoveryApiRef,
        fetchApi: fetchApiRef,
      },
      factory: ({ discoveryApi, fetchApi }) =>
        new OpenSearchViewerClient({ discoveryApi, fetchApi }),
    }),
  ],
});

export const OpenSearchViewerPage = opensearchViewerPlugin.provide(
  createRoutableExtension({
    name: 'OpenSearchViewerPage',
    component: () =>
      import('./components/OpenSearchViewerPage').then(
        m => m.OpenSearchViewerPage,
      ),
    mountPoint: rootRouteRef,
  }),
);
