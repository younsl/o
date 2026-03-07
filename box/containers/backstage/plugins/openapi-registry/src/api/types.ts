/**
 * Types for OpenAPI Registry Frontend
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

export interface PreviewResult {
  valid: boolean;
  spec?: {
    openapi?: string;
    swagger?: string;
    info: {
      title: string;
      description?: string;
      version: string;
    };
  };
  error?: string;
  name?: string;
  title?: string;
  description?: string;
  version?: string;
}
