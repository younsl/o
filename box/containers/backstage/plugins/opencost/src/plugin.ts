import {
  createPlugin,
  createRoutableExtension,
} from '@backstage/core-plugin-api';
import { rootRouteRef } from './routes';

export const opencostPlugin = createPlugin({
  id: 'opencost',
  routes: {
    root: rootRouteRef,
  },
});

export const OpenCostPage = opencostPlugin.provide(
  createRoutableExtension({
    name: 'OpenCostPage',
    component: () =>
      import('./components/OpenCostPage').then(m => m.OpenCostPage),
    mountPoint: rootRouteRef,
  }),
);
