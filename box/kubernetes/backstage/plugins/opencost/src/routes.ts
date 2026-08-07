import { createRouteRef } from '@backstage/core-plugin-api';

export const rootRouteRef = createRouteRef({
  id: 'opencost',
});

export const adjustRouteRef = createRouteRef({
  id: 'opencost-adjust',
});
