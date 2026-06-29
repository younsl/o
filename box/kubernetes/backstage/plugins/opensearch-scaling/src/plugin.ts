import {
  createApiFactory,
  createPlugin,
  createRoutableExtension,
  discoveryApiRef,
  fetchApiRef,
} from '@backstage/core-plugin-api';
import { rootRouteRef, createReservationRouteRef } from './routes';
import { opensearchScalingApiRef, OpenSearchScalingClient } from './api';

export const opensearchScalingPlugin = createPlugin({
  id: 'opensearch-scaling',
  routes: {
    root: rootRouteRef,
    create: createReservationRouteRef,
  },
  apis: [
    createApiFactory({
      api: opensearchScalingApiRef,
      deps: {
        discoveryApi: discoveryApiRef,
        fetchApi: fetchApiRef,
      },
      factory: ({ discoveryApi, fetchApi }) =>
        new OpenSearchScalingClient({ discoveryApi, fetchApi }),
    }),
  ],
});

export const OpenSearchScalingPage = opensearchScalingPlugin.provide(
  createRoutableExtension({
    name: 'OpenSearchScalingPage',
    component: () =>
      import('./components/ReservationsPage').then(m => m.ReservationsPage),
    mountPoint: rootRouteRef,
  }),
);

export const OpenSearchScalingCreatePage = opensearchScalingPlugin.provide(
  createRoutableExtension({
    name: 'OpenSearchScalingCreatePage',
    component: () =>
      import('./components/CreateReservationPage').then(
        m => m.CreateReservationPage,
      ),
    mountPoint: createReservationRouteRef,
  }),
);
