import {
  coreServices,
  createBackendPlugin,
} from '@backstage/backend-plugin-api';
import { CatalogClient } from '@backstage/catalog-client';
import { createRouter } from './service/router';
import { OpenApiRegistryStore } from './service/OpenApiRegistryStore';
import { OpenApiRegistryService } from './service/OpenApiRegistryService';

/**
 * OpenAPI Registry Backend Plugin
 *
 * Provides REST API endpoints for:
 * - Registering OpenAPI/Swagger specs by URL
 * - Manually refreshing registered APIs
 * - Listing and managing registered APIs
 *
 * Creates API entities in the Backstage Catalog via Location registration.
 * Note: Entities appear in the Catalog after 1-2 minutes (async processing).
 */
export const openApiRegistryPlugin = createBackendPlugin({
  pluginId: 'openapi-registry',
  register(env) {
    env.registerInit({
      deps: {
        httpRouter: coreServices.httpRouter,
        logger: coreServices.logger,
        database: coreServices.database,
        discovery: coreServices.discovery,
        auth: coreServices.auth,
        auditor: coreServices.auditor,
      },
      async init({ httpRouter, logger, database, discovery, auth, auditor }) {
        logger.info('Initializing OpenAPI Registry backend plugin');

        // Get database client
        const knex = await database.getClient();

        // Create store
        const store = await OpenApiRegistryStore.create({ database: knex });

        // Create catalog client for adding locations
        const catalogClient = new CatalogClient({ discoveryApi: discovery });

        // Get our plugin's base URL for serving entity YAML
        const baseUrl = await discovery.getBaseUrl('openapi-registry');

        // Create service
        const service = new OpenApiRegistryService({
          store,
          catalogClient,
          auth,
          logger,
          baseUrl,
        });

        // Create and register router
        const router = await createRouter({
          service,
          logger,
          auditor,
        });

        httpRouter.use(router as any);
        httpRouter.addAuthPolicy({
          path: '/health',
          allow: 'unauthenticated',
        });
        // Allow catalog to fetch entity YAML without auth
        httpRouter.addAuthPolicy({
          path: '/entity/*',
          allow: 'unauthenticated',
        });

        logger.info('OpenAPI Registry backend plugin initialized');
      },
    });
  },
});

export default openApiRegistryPlugin;
