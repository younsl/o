import { CatalogApi } from '@backstage/catalog-client';
import { stringifyEntityRef } from '@backstage/catalog-model';
import { LoggerService, AuthService } from '@backstage/backend-plugin-api';
import fetch from 'node-fetch';
import yaml from 'js-yaml';
import { OpenApiRegistryStore } from './OpenApiRegistryStore';
import {
  OpenApiRegistration,
  OpenApiSpec,
  PreviewResult,
  RegisterApiRequest,
} from './types';

export interface OpenApiRegistryServiceOptions {
  store: OpenApiRegistryStore;
  catalogClient: CatalogApi;
  auth: AuthService;
  logger: LoggerService;
  baseUrl: string;
}

export class OpenApiRegistryService {
  private readonly store: OpenApiRegistryStore;
  private readonly catalogClient: CatalogApi;
  private readonly auth: AuthService;
  private readonly logger: LoggerService;
  private readonly baseUrl: string;

  constructor(options: OpenApiRegistryServiceOptions) {
    this.store = options.store;
    this.catalogClient = options.catalogClient;
    this.auth = options.auth;
    this.logger = options.logger;
    this.baseUrl = options.baseUrl;
  }

  async previewSpec(specUrl: string): Promise<PreviewResult> {
    try {
      const spec = await this.fetchSpec(specUrl);
      return {
        valid: true,
        spec,
        name: this.generateApiName(spec.info.title),
        title: spec.info.title,
        description: spec.info.description,
        version: spec.info.version,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        valid: false,
        error: message,
      };
    }
  }

  async registerApi(request: RegisterApiRequest): Promise<OpenApiRegistration> {
    this.logger.info(`Registering API from URL: ${request.specUrl}`);

    // Check if already registered
    const existing = await this.store.getRegistrationByUrl(request.specUrl);
    if (existing) {
      throw new Error(`API spec at ${request.specUrl} is already registered as ${existing.name}`);
    }

    const existingName = await this.store.getRegistrationByName(request.name);
    if (existingName) {
      throw new Error(`API with name ${request.name} already exists`);
    }

    // Fetch and validate the spec
    const spec = await this.fetchSpec(request.specUrl);

    const entityRef = stringifyEntityRef({
      kind: 'API',
      namespace: 'default',
      name: request.name,
    });

    // Store the registration first (so entity endpoint works)
    const registration = await this.store.createRegistration(
      request,
      entityRef,
      spec.info.description,
      undefined, // locationId will be updated after
    );

    // Get service credentials for catalog API calls
    const { token } = await this.auth.getPluginRequestToken({
      onBehalfOf: await this.auth.getOwnServiceCredentials(),
      targetPluginId: 'catalog',
    });

    // Add location to catalog using our entity endpoint
    const entityUrl = `${this.baseUrl}/entity/${request.name}`;
    this.logger.info(`Registering catalog location: ${entityUrl}`);

    let locationId: string | undefined;

    try {
      const locationResponse = await this.catalogClient.addLocation(
        {
          type: 'url',
          target: entityUrl,
        },
        { token },
      );
      locationId = locationResponse.location.id;
      this.logger.info(`Created catalog location: ${locationId}`);

      // Update the registration with the location ID
      await this.store.updateLocationId(registration.id, locationId);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to add location to catalog: ${errorMessage}`);
      // Registration is saved, location can be added later via refresh
    }

    this.logger.info(`API registered successfully: ${registration.name}`);
    return { ...registration, locationId };
  }

  async refreshApi(id: string): Promise<OpenApiRegistration> {
    const registration = await this.store.getRegistration(id);
    if (!registration) {
      throw new Error(`Registration with id ${id} not found`);
    }

    this.logger.info(`Refreshing API: ${registration.name}`);

    // Fetch the updated spec
    const spec = await this.fetchSpec(registration.specUrl);

    // Get service credentials
    const { token } = await this.auth.getPluginRequestToken({
      onBehalfOf: await this.auth.getOwnServiceCredentials(),
      targetPluginId: 'catalog',
    });

    // If no location ID, try to create the catalog location
    if (!registration.locationId) {
      const entityUrl = `${this.baseUrl}/entity/${registration.name}`;
      this.logger.info(`No location ID found, creating catalog location: ${entityUrl}`);

      try {
        const locationResponse = await this.catalogClient.addLocation(
          {
            type: 'url',
            target: entityUrl,
          },
          { token },
        );
        const locationId = locationResponse.location.id;
        this.logger.info(`Created catalog location: ${locationId}`);
        await this.store.updateLocationId(id, locationId);
      } catch (error) {
        this.logger.warn(`Failed to create catalog location: ${error}`);
      }
    } else {
      // Refresh the entity in catalog
      try {
        await this.catalogClient.refreshEntity(registration.entityRef, { token });
        this.logger.info(`Refreshed entity in catalog: ${registration.entityRef}`);
      } catch (error) {
        this.logger.warn(`Failed to refresh entity in catalog: ${error}`);
      }
    }

    // Update local registration record
    await this.store.updateLastSyncedAt(id);
    await this.store.updateRegistration(id, {
      title: spec.info.title,
      description: spec.info.description,
    });

    this.logger.info(`API refreshed successfully: ${registration.name}`);

    return (await this.store.getRegistration(id))!;
  }

  async listRegistrations(): Promise<OpenApiRegistration[]> {
    return this.store.listRegistrations();
  }

  async getRegistration(id: string): Promise<OpenApiRegistration | undefined> {
    return this.store.getRegistration(id);
  }

  async getEntityYaml(name: string): Promise<string | null> {
    const registration = await this.store.getRegistrationByName(name);
    if (!registration) {
      return null;
    }

    try {
      const spec = await this.fetchSpec(registration.specUrl);
      const entity = this.createApiEntity(registration, spec);
      return yaml.dump(entity);
    } catch (error) {
      this.logger.error(`Failed to generate entity YAML for ${name}: ${error}`);
      return null;
    }
  }

  async deleteRegistration(id: string): Promise<void> {
    const registration = await this.store.getRegistration(id);
    if (!registration) {
      throw new Error(`Registration with id ${id} not found`);
    }

    this.logger.info(`Deleting API registration: ${registration.name}`);

    // Get service credentials
    const { token } = await this.auth.getPluginRequestToken({
      onBehalfOf: await this.auth.getOwnServiceCredentials(),
      targetPluginId: 'catalog',
    });

    // Remove location from catalog if we have the location ID
    if (registration.locationId) {
      try {
        await this.catalogClient.removeLocationById(registration.locationId, { token });
        this.logger.info(`Removed catalog location: ${registration.locationId}`);
      } catch (error) {
        this.logger.warn(`Failed to remove location from catalog: ${error}`);
      }
    }

    // Remove from store
    await this.store.deleteRegistration(id);

    this.logger.info(`API registration deleted: ${registration.name}`);
  }

  private async fetchSpec(specUrl: string): Promise<OpenApiSpec> {
    this.logger.debug(`Fetching spec from: ${specUrl}`);

    const response = await fetch(specUrl, {
      headers: {
        Accept: 'application/json, application/yaml, text/yaml, */*',
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch spec: ${response.status} ${response.statusText}`);
    }

    const contentType = response.headers.get('content-type') || '';
    const text = await response.text();

    let spec: OpenApiSpec;

    if (contentType.includes('yaml') || specUrl.endsWith('.yaml') || specUrl.endsWith('.yml')) {
      spec = yaml.load(text) as OpenApiSpec;
    } else {
      try {
        spec = JSON.parse(text);
      } catch {
        // Try YAML as fallback
        spec = yaml.load(text) as OpenApiSpec;
      }
    }

    // Validate it's an OpenAPI/Swagger spec
    if (!spec.openapi && !spec.swagger) {
      throw new Error('Invalid spec: missing openapi or swagger version field');
    }

    if (!spec.info?.title) {
      throw new Error('Invalid spec: missing info.title');
    }

    return spec;
  }

  private createApiEntity(registration: OpenApiRegistration, spec: OpenApiSpec) {
    const specVersion = spec.openapi || spec.swagger || '3.0.0';
    const specYaml = yaml.dump(spec);

    return {
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'API',
      metadata: {
        name: registration.name,
        namespace: 'default',
        title: registration.title || spec.info.title,
        description: spec.info.description || `OpenAPI spec from ${registration.specUrl}`,
        annotations: {
          'openapi-registry/source-url': registration.specUrl,
          'openapi-registry/spec-version': specVersion,
          'openapi-registry/api-version': spec.info.version,
        },
        tags: registration.tags || ['openapi', 'rest'],
      },
      spec: {
        type: 'openapi',
        lifecycle: registration.lifecycle,
        owner: registration.owner,
        definition: specYaml,
      },
    };
  }

  private generateApiName(title: string): string {
    return title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 63);
  }
}
