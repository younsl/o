import {
  coreServices,
  createBackendPlugin,
} from '@backstage/backend-plugin-api';
import { createRouter } from './service/router';
import { GrafanaDashboardMapStore } from './service/GrafanaDashboardMapStore';
import { GrafanaClient } from './service/GrafanaClient';

export const grafanaDashboardMapPlugin = createBackendPlugin({
  pluginId: 'grafana-dashboard-map',
  register(env) {
    env.registerInit({
      deps: {
        httpRouter: coreServices.httpRouter,
        httpAuth: coreServices.httpAuth,
        logger: coreServices.logger,
        config: coreServices.rootConfig,
        database: coreServices.database,
        auditor: coreServices.auditor,
      },
      async init({ httpRouter, httpAuth, logger, config, database, auditor }) {
        const enabled =
          config.getOptionalBoolean('app.plugins.grafanaDashboardMap') ?? true;
        if (!enabled) {
          logger.info('Grafana Dashboard Map plugin disabled via config');
          return;
        }

        const grafanaUrl = config.getOptionalString('grafanaDashboardMap.url');
        const grafanaToken = config.getOptionalString('grafanaDashboardMap.apiToken');
        if (!grafanaUrl || !grafanaToken) {
          logger.warn(
            'Grafana Dashboard Map: grafanaDashboardMap.url or apiToken missing. The /dashboards endpoint will fail until configured.',
          );
        }

        const cacheTtl =
          config.getOptionalNumber('grafanaDashboardMap.cacheTtlSeconds') ?? 60;

        const knex = await database.getClient();
        const store = await GrafanaDashboardMapStore.create({ database: knex });

        const grafana = new GrafanaClient({
          baseUrl: grafanaUrl ?? 'http://localhost:3000',
          apiToken: grafanaToken ?? '',
          cacheTtlSeconds: cacheTtl,
          logger,
        });

        const router = await createRouter({
          store,
          grafana,
          logger,
          config,
          httpAuth,
          auditor,
        });

        httpRouter.use(router as any);
        httpRouter.addAuthPolicy({
          path: '/health',
          allow: 'unauthenticated',
        });

        logger.info('Grafana Dashboard Map backend plugin initialized');
      },
    });
  },
});

export default grafanaDashboardMapPlugin;
