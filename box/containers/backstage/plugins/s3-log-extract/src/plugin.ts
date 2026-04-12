import {
  createApiFactory,
  createPlugin,
  createRoutableExtension,
  discoveryApiRef,
  fetchApiRef,
} from '@backstage/core-plugin-api';
import { rootRouteRef } from './routes';
import { s3LogExtractApiRef, S3LogExtractClient } from './api';

export const s3LogExtractPlugin = createPlugin({
  id: 's3-log-extract',
  routes: {
    root: rootRouteRef,
  },
  apis: [
    createApiFactory({
      api: s3LogExtractApiRef,
      deps: {
        discoveryApi: discoveryApiRef,
        fetchApi: fetchApiRef,
      },
      factory: ({ discoveryApi, fetchApi }) =>
        new S3LogExtractClient({ discoveryApi, fetchApi }),
    }),
  ],
});

export const S3LogExtractPage = s3LogExtractPlugin.provide(
  createRoutableExtension({
    name: 'S3LogExtractPage',
    component: () =>
      import('./components/S3LogExtractPage').then(m => m.S3LogExtractPage),
    mountPoint: rootRouteRef,
  }),
);
