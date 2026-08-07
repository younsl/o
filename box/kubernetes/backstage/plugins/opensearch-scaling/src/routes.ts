import { createRouteRef } from '@backstage/core-plugin-api';

export const rootRouteRef = createRouteRef({
  id: 'opensearch-scaling',
});

export const createReservationRouteRef = createRouteRef({
  id: 'opensearch-scaling-create',
});
