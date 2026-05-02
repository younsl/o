import {
  createApiFactory,
  createPlugin,
  createRoutableExtension,
  discoveryApiRef,
  fetchApiRef,
} from '@backstage/core-plugin-api';
import { rootRouteRef } from './routes';
import { grafanaDashboardMapApiRef, GrafanaDashboardMapClient } from './api';

export const grafanaDashboardMapPlugin = createPlugin({
  id: 'grafana-dashboard-map',
  routes: {
    root: rootRouteRef,
  },
  apis: [
    createApiFactory({
      api: grafanaDashboardMapApiRef,
      deps: {
        discoveryApi: discoveryApiRef,
        fetchApi: fetchApiRef,
      },
      factory: ({ discoveryApi, fetchApi }) =>
        new GrafanaDashboardMapClient({ discoveryApi, fetchApi }),
    }),
  ],
});

export const GrafanaDashboardMapPage = grafanaDashboardMapPlugin.provide(
  createRoutableExtension({
    name: 'GrafanaDashboardMapPage',
    component: () =>
      import('./components/GrafanaDashboardMapPage').then(m => m.GrafanaDashboardMapPage),
    mountPoint: rootRouteRef,
  }),
);
