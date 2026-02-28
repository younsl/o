/**
 * OpenAPI Registry Backend Plugin
 *
 * Provides REST API for registering OpenAPI/Swagger specs.
 * Registrations are stored in a local database table.
 * Entities are created via Location registration (async processing).
 */

export { openApiRegistryPlugin as default } from './plugin';
export * from './service/types';
