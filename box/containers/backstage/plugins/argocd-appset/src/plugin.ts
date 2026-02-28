import {
  createApiFactory,
  createPlugin,
  createRoutableExtension,
  discoveryApiRef,
  fetchApiRef,
} from '@backstage/core-plugin-api';
import { rootRouteRef } from './routes';
import { argocdAppsetApiRef, ArgocdAppsetClient } from './api';

export const argocdAppsetPlugin = createPlugin({
  id: 'argocd-appset',
  routes: {
    root: rootRouteRef,
  },
  apis: [
    createApiFactory({
      api: argocdAppsetApiRef,
      deps: {
        discoveryApi: discoveryApiRef,
        fetchApi: fetchApiRef,
      },
      factory: ({ discoveryApi, fetchApi }) =>
        new ArgocdAppsetClient({ discoveryApi, fetchApi }),
    }),
  ],
});

export const ArgocdAppsetPage = argocdAppsetPlugin.provide(
  createRoutableExtension({
    name: 'ArgocdAppsetPage',
    component: () =>
      import('./components/ArgocdAppsetPage').then(m => m.ArgocdAppsetPage),
    mountPoint: rootRouteRef,
  }),
);
