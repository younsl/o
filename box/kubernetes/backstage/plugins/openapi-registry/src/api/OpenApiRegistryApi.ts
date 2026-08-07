import { createApiRef } from '@backstage/core-plugin-api';
import {
  OpenApiRegistration,
  PreviewResult,
  RegisterApiRequest,
} from './types';

/**
 * API for interacting with the OpenAPI Registry backend
 */
export interface OpenApiRegistryApi {
  /**
   * Preview an OpenAPI spec before registering
   */
  previewSpec(specUrl: string): Promise<PreviewResult>;

  /**
   * Register a new API from an OpenAPI spec URL
   */
  registerApi(request: RegisterApiRequest): Promise<OpenApiRegistration>;

  /**
   * List all registered APIs
   */
  listRegistrations(): Promise<OpenApiRegistration[]>;

  /**
   * Get a single registration by ID
   */
  getRegistration(id: string): Promise<OpenApiRegistration>;

  /**
   * Refresh an API (re-fetch spec and update entity)
   */
  refreshApi(id: string): Promise<OpenApiRegistration>;

  /**
   * Delete a registration
   */
  deleteRegistration(id: string): Promise<void>;
}

export const openApiRegistryApiRef = createApiRef<OpenApiRegistryApi>({
  id: 'plugin.openapi-registry.api',
});
