import {
  createApiFactory,
  createPlugin,
  createRoutableExtension,
  discoveryApiRef,
  fetchApiRef,
} from '@backstage/core-plugin-api';
import { rootRouteRef } from './routes';
import { openApiRegistryApiRef, OpenApiRegistryClient } from './api';

/**
 * OpenAPI Registry Frontend Plugin
 *
 * Provides UI for:
 * - Registering OpenAPI/Swagger specs by URL
 * - Viewing registered APIs
 * - Manually refreshing registered APIs
 */
export const openApiRegistryPlugin = createPlugin({
  id: 'openapi-registry',
  routes: {
    root: rootRouteRef,
  },
  apis: [
    createApiFactory({
      api: openApiRegistryApiRef,
      deps: {
        discoveryApi: discoveryApiRef,
        fetchApi: fetchApiRef,
      },
      factory: ({ discoveryApi, fetchApi }) =>
        new OpenApiRegistryClient({ discoveryApi, fetchApi }),
    }),
  ],
});

/**
 * Main page for OpenAPI Registry
 */
export const OpenApiRegistryPage = openApiRegistryPlugin.provide(
  createRoutableExtension({
    name: 'OpenApiRegistryPage',
    component: () =>
      import('./components/OpenApiRegistryPage').then(m => m.OpenApiRegistryPage),
    mountPoint: rootRouteRef,
  }),
);
