import {
  createApiFactory,
  createPlugin,
  createRoutableExtension,
  discoveryApiRef,
  fetchApiRef,
} from '@backstage/core-plugin-api';
import { rootRouteRef, generateRouteRef } from './routes';
import { catalogHealthApiRef, CatalogHealthClient } from './api';

export const catalogHealthPlugin = createPlugin({
  id: 'catalog-health',
  routes: {
    root: rootRouteRef,
    generate: generateRouteRef,
  },
  apis: [
    createApiFactory({
      api: catalogHealthApiRef,
      deps: {
        discoveryApi: discoveryApiRef,
        fetchApi: fetchApiRef,
      },
      factory: ({ discoveryApi, fetchApi }) =>
        new CatalogHealthClient({ discoveryApi, fetchApi }),
    }),
  ],
});

export const CatalogHealthPage = catalogHealthPlugin.provide(
  createRoutableExtension({
    name: 'CatalogHealthPage',
    component: () =>
      import('./components/CatalogHealthPage/CatalogHealthPage').then(
        m => m.CatalogHealthPage,
      ),
    mountPoint: rootRouteRef,
  }),
);

export const GenerateCatalogInfoPage = catalogHealthPlugin.provide(
  createRoutableExtension({
    name: 'GenerateCatalogInfoPage',
    component: () =>
      import('./components/GenerateCatalogInfoPage/GenerateCatalogInfoPage').then(
        m => m.GenerateCatalogInfoPage,
      ),
    mountPoint: generateRouteRef,
  }),
);
