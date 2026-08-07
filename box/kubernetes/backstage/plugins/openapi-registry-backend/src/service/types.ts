/**
 * Types for OpenAPI Registry
 */

export interface OpenApiRegistration {
  id: string;
  specUrl: string;
  entityRef: string;
  name: string;
  title?: string;
  description?: string;
  owner: string;
  lifecycle: string;
  tags?: string[];
  locationId?: string;
  lastSyncedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface RegisterApiRequest {
  specUrl: string;
  name: string;
  title?: string;
  owner: string;
  lifecycle: string;
  tags?: string[];
}

export interface RefreshApiRequest {
  id: string;
}

export interface OpenApiSpec {
  openapi?: string;
  swagger?: string;
  info: {
    title: string;
    description?: string;
    version: string;
  };
  paths?: Record<string, unknown>;
  servers?: Array<{ url: string; description?: string }>;
}

export interface PreviewResult {
  valid: boolean;
  spec?: OpenApiSpec;
  error?: string;
  name?: string;
  title?: string;
  description?: string;
  version?: string;
}
