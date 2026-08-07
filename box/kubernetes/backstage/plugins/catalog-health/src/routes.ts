import { createRouteRef } from '@backstage/core-plugin-api';

export const rootRouteRef = createRouteRef({
  id: 'catalog-health',
});

export const generateRouteRef = createRouteRef({
  id: 'catalog-health/generate',
});
