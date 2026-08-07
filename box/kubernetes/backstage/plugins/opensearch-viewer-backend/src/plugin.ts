import {
  coreServices,
  createBackendPlugin,
} from '@backstage/backend-plugin-api';
import { Config } from '@backstage/config';
import { createRouter } from './service/router';
import { OpenSearchDataClient } from './service/OpenSearchDataClient';
import { OpenSearchConflictStore } from './service/OpenSearchConflictStore';
import { OpenSearchConflictService } from './service/OpenSearchConflictService';
import { OpenSearchViewerTarget } from './service/types';

const DEFAULT_SCAN_CRON = '*/15 * * * *';

function slug(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'target';
}

function readTargets(config: Config): OpenSearchViewerTarget[] {
  const viewer = config.getOptionalConfig('opensearchViewer');
  const targetConfigs = viewer?.getOptionalConfigArray('targets');
  const rawTargets =
    targetConfigs && targetConfigs.length > 0
      ? targetConfigs.map((target, index) => {
          const indexPattern = target.getString('indexPattern');
          return {
            name: target.getOptionalString('name') ?? indexPattern,
            indexPattern,
            index,
          };
        })
      : (viewer?.getOptionalStringArray('indexPatterns') ?? ['*']).map(
          (indexPattern, index) => ({
            name: indexPattern,
            indexPattern,
            index,
          }),
        );

  const used = new Set<string>();
  return rawTargets.map(target => {
    const base = slug(target.name || target.indexPattern || `target-${target.index + 1}`);
    let id = base;
    let suffix = 2;
    while (used.has(id)) {
      id = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(id);
    return {
      id,
      name: target.name,
      indexPattern: target.indexPattern,
    };
  });
}

export const opensearchViewerPlugin = createBackendPlugin({
  pluginId: 'opensearch-viewer',
  register(env) {
    env.registerInit({
      deps: {
        httpRouter: coreServices.httpRouter,
        httpAuth: coreServices.httpAuth,
        logger: coreServices.logger,
        config: coreServices.rootConfig,
        database: coreServices.database,
        scheduler: coreServices.scheduler,
      },
      async init({ httpRouter, httpAuth, logger, config, database, scheduler }) {
        const enabled =
          config.getOptionalBoolean('app.plugins.opensearchViewer') ?? true;
        if (!enabled) {
          logger.info('OpenSearch Viewer backend plugin is disabled via config');
          return;
        }

        logger.info('Initializing OpenSearch Viewer backend plugin');
        const client = OpenSearchDataClient.fromConfig(config, logger);
        if (!client) {
          logger.warn(
            'OpenSearch Viewer has no endpoint configured; UI will show configuration status only',
          );
        }

        const knex = await database.getClient();
        const store = await OpenSearchConflictStore.create({ database: knex });
        const targets = readTargets(config);
        const ignoredIndexPatterns =
          config.getOptionalStringArray('opensearchViewer.ignoredIndexPatterns') ??
          ['.kibana*', '.opensearch-*'];
        const scanCron =
          config.getOptionalString('opensearchViewer.scanCron') ??
          DEFAULT_SCAN_CRON;

        const service = new OpenSearchConflictService({
          logger,
          client,
          store,
          targets,
          ignoredIndexPatterns,
        });

        const router = await createRouter({
          logger,
          config,
          httpAuth,
          service,
          scanCron,
        });
        httpRouter.use(router as any);
        httpRouter.addAuthPolicy({ path: '/health', allow: 'unauthenticated' });

        if (client) {
          await scheduler.scheduleTask({
            id: 'opensearch-viewer-conflict-scan',
            frequency: { cron: scanCron },
            timeout: { minutes: 30 },
            initialDelay: { seconds: 30 },
            fn: async () => {
              // Scheduled scans are intentional background work and bypass the HTTP manual refresh guard.
              await service.scanAll();
            },
          });
        }

        logger.info('OpenSearch Viewer backend plugin initialized');
      },
    });
  },
});
