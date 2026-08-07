import {
  createApiFactory,
  createPlugin,
  createRoutableExtension,
  discoveryApiRef,
  fetchApiRef,
} from '@backstage/core-plugin-api';
import { rootRouteRef } from './routes';
import { kafkaTopicApiRef } from './api/KafkaTopicApi';
import { KafkaTopicClient } from './api/KafkaTopicClient';

export const kafkaTopicPlugin = createPlugin({
  id: 'kafka-topic',
  routes: {
    root: rootRouteRef,
  },
  apis: [
    createApiFactory({
      api: kafkaTopicApiRef,
      deps: {
        discoveryApi: discoveryApiRef,
        fetchApi: fetchApiRef,
      },
      factory: ({ discoveryApi, fetchApi }) =>
        new KafkaTopicClient({ discoveryApi, fetchApi }),
    }),
  ],
});

export const KafkaTopicPage = kafkaTopicPlugin.provide(
  createRoutableExtension({
    name: 'KafkaTopicPage',
    component: () =>
      import('./components/KafkaTopicPage/KafkaTopicPage').then(
        m => m.KafkaTopicPage,
      ),
    mountPoint: rootRouteRef,
  }),
);
