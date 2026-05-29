import {
  createPlugin,
  createRoutableExtension,
} from '@backstage/core-plugin-api';
import { rootRouteRef, adjustRouteRef } from './routes';

export const opencostPlugin = createPlugin({
  id: 'opencost',
  routes: {
    root: rootRouteRef,
    adjust: adjustRouteRef,
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

export const CostAdjustPage = opencostPlugin.provide(
  createRoutableExtension({
    name: 'CostAdjustPage',
    component: () =>
      import('./components/CostAdjustPage').then(m => m.CostAdjustPage),
    mountPoint: adjustRouteRef,
  }),
);
