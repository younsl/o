jest.mock('node-fetch', () => jest.fn());

import fetch from 'node-fetch';
import { OpenApiRegistryService } from './OpenApiRegistryService';
import { OpenApiSpec } from './types';

const mockFetch = fetch as jest.MockedFunction<typeof fetch>;

const mockStore = {
  getRegistrationByUrl: jest.fn(),
  getRegistrationByName: jest.fn(),
  createRegistration: jest.fn(),
  updateLocationId: jest.fn(),
  getRegistration: jest.fn(),
  updateLastSyncedAt: jest.fn(),
  updateRegistration: jest.fn(),
  listRegistrations: jest.fn(),
  deleteRegistration: jest.fn(),
};

const mockCatalogClient = {
  addLocation: jest.fn(),
  refreshEntity: jest.fn(),
  removeLocationById: jest.fn(),
};

const mockAuth = {
  getPluginRequestToken: jest.fn().mockResolvedValue({ token: 'mock-token' }),
  getOwnServiceCredentials: jest.fn().mockResolvedValue({}),
};

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  child: jest.fn().mockReturnThis(),
} as any;

function createService() {
  return new OpenApiRegistryService({
    store: mockStore as any,
    catalogClient: mockCatalogClient as any,
    auth: mockAuth as any,
    logger: mockLogger,
    baseUrl: 'http://localhost:7007/api/openapi-registry',
  });
}

function mockFetchResponse(body: string, options: { ok?: boolean; contentType?: string } = {}) {
  mockFetch.mockResolvedValueOnce({
    ok: options.ok ?? true,
    status: options.ok === false ? 500 : 200,
    statusText: options.ok === false ? 'Internal Server Error' : 'OK',
    headers: { get: () => options.contentType ?? 'application/json' },
    text: () => Promise.resolve(body),
  } as any);
}

const validOpenApi3: OpenApiSpec = {
  openapi: '3.0.0',
  info: { title: 'Pet Store API', description: 'A sample API', version: '1.0.0' },
  paths: {},
};

const validSwagger2: OpenApiSpec = {
  swagger: '2.0',
  info: { title: 'Legacy API', description: 'Swagger 2.0', version: '1.0.0' },
  paths: {},
};

describe('OpenApiRegistryService', () => {
  let service: OpenApiRegistryService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = createService();
  });

  describe('previewSpec', () => {
    it('returns valid result for OpenAPI 3.0 JSON', async () => {
      mockFetchResponse(JSON.stringify(validOpenApi3));

      const result = await service.previewSpec('https://example.com/openapi.json');
      expect(result.valid).toBe(true);
      expect(result.name).toBe('pet-store-api');
      expect(result.title).toBe('Pet Store API');
      expect(result.version).toBe('1.0.0');
    });

    it('returns valid result for Swagger 2.0 spec', async () => {
      mockFetchResponse(JSON.stringify(validSwagger2));

      const result = await service.previewSpec('https://example.com/swagger.json');
      expect(result.valid).toBe(true);
      expect(result.title).toBe('Legacy API');
    });

    it('parses YAML when content-type is yaml', async () => {
      const yamlBody = `openapi: "3.0.0"\ninfo:\n  title: "YAML API"\n  version: "1.0.0"\npaths: {}`;
      mockFetchResponse(yamlBody, { contentType: 'application/yaml' });

      const result = await service.previewSpec('https://example.com/spec');
      expect(result.valid).toBe(true);
      expect(result.title).toBe('YAML API');
    });

    it('parses YAML when URL ends with .yaml', async () => {
      const yamlBody = `openapi: "3.0.0"\ninfo:\n  title: "YAML Ext API"\n  version: "2.0.0"\npaths: {}`;
      mockFetchResponse(yamlBody, { contentType: 'text/plain' });

      const result = await service.previewSpec('https://example.com/spec.yaml');
      expect(result.valid).toBe(true);
      expect(result.title).toBe('YAML Ext API');
    });

    it('returns invalid when HTTP request fails', async () => {
      mockFetchResponse('', { ok: false });

      const result = await service.previewSpec('https://example.com/bad');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Failed to fetch spec');
    });

    it('returns invalid when openapi/swagger field is missing', async () => {
      mockFetchResponse(JSON.stringify({ info: { title: 'No Version', version: '1.0' } }));

      const result = await service.previewSpec('https://example.com/bad.json');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('missing openapi or swagger');
    });

    it('returns invalid when info.title is missing', async () => {
      mockFetchResponse(JSON.stringify({ openapi: '3.0.0', info: { version: '1.0' } }));

      const result = await service.previewSpec('https://example.com/bad.json');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('missing info.title');
    });

    it('generates slugified name from title', async () => {
      const spec = { ...validOpenApi3, info: { title: 'My Cool API v2.0', version: '2.0' } };
      mockFetchResponse(JSON.stringify(spec));

      const result = await service.previewSpec('https://example.com/api.json');
      expect(result.name).toBe('my-cool-api-v2-0');
    });

    it('truncates name to 63 characters', async () => {
      const longTitle = 'A'.repeat(100) + ' Very Long API Name';
      const spec = { ...validOpenApi3, info: { title: longTitle, version: '1.0' } };
      mockFetchResponse(JSON.stringify(spec));

      const result = await service.previewSpec('https://example.com/api.json');
      expect(result.name!.length).toBeLessThanOrEqual(63);
    });
  });

  describe('registerApi', () => {
    const registerRequest = {
      specUrl: 'https://example.com/api.json',
      name: 'pet-store-api',
      owner: 'team-a',
      lifecycle: 'production',
    };

    const storedRegistration = {
      id: 'reg-001',
      specUrl: 'https://example.com/api.json',
      entityRef: 'api:default/pet-store-api',
      name: 'pet-store-api',
      owner: 'team-a',
      lifecycle: 'production',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      lastSyncedAt: '2024-01-01T00:00:00Z',
    };

    it('throws when URL is already registered', async () => {
      mockStore.getRegistrationByUrl.mockResolvedValue({ id: 'existing', name: 'existing-api' });

      await expect(service.registerApi(registerRequest)).rejects.toThrow('already registered');
    });

    it('throws when name already exists', async () => {
      mockStore.getRegistrationByUrl.mockResolvedValue(undefined);
      mockStore.getRegistrationByName.mockResolvedValue({ id: 'existing' });

      await expect(
        service.registerApi({ ...registerRequest, specUrl: 'https://example.com/new.json' }),
      ).rejects.toThrow('already exists');
    });

    it('registers API and adds catalog location', async () => {
      mockStore.getRegistrationByUrl.mockResolvedValue(undefined);
      mockStore.getRegistrationByName.mockResolvedValue(undefined);
      mockStore.createRegistration.mockResolvedValue(storedRegistration);
      mockCatalogClient.addLocation.mockResolvedValue({
        location: { id: 'loc-abc' },
      });
      mockFetchResponse(JSON.stringify(validOpenApi3));

      const result = await service.registerApi(registerRequest);

      expect(result.id).toBe('reg-001');
      expect(result.locationId).toBe('loc-abc');
      expect(mockStore.createRegistration).toHaveBeenCalled();
      expect(mockCatalogClient.addLocation).toHaveBeenCalledWith(
        { type: 'url', target: 'http://localhost:7007/api/openapi-registry/entity/pet-store-api' },
        { token: 'mock-token' },
      );
      expect(mockStore.updateLocationId).toHaveBeenCalledWith('reg-001', 'loc-abc');
    });

    it('succeeds even when catalog location fails', async () => {
      mockStore.getRegistrationByUrl.mockResolvedValue(undefined);
      mockStore.getRegistrationByName.mockResolvedValue(undefined);
      mockStore.createRegistration.mockResolvedValue(storedRegistration);
      mockCatalogClient.addLocation.mockRejectedValue(new Error('catalog down'));
      mockFetchResponse(JSON.stringify(validOpenApi3));

      const result = await service.registerApi(registerRequest);

      expect(result.id).toBe('reg-001');
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  describe('refreshApi', () => {
    const existingReg = {
      id: 'reg-001',
      specUrl: 'https://example.com/api.json',
      entityRef: 'api:default/pet-store-api',
      name: 'pet-store-api',
      locationId: 'loc-abc',
      owner: 'team-a',
      lifecycle: 'production',
    };

    it('refreshes entity in catalog when locationId exists', async () => {
      mockStore.getRegistration
        .mockResolvedValueOnce(existingReg)
        .mockResolvedValueOnce({ ...existingReg, lastSyncedAt: '2024-06-01T00:00:00Z' });
      mockFetchResponse(JSON.stringify(validOpenApi3));

      const result = await service.refreshApi('reg-001');

      expect(mockCatalogClient.refreshEntity).toHaveBeenCalledWith(
        'api:default/pet-store-api',
        { token: 'mock-token' },
      );
      expect(mockStore.updateLastSyncedAt).toHaveBeenCalledWith('reg-001');
      expect(result.name).toBe('pet-store-api');
    });

    it('creates catalog location when locationId is missing', async () => {
      const regNoLocation = { ...existingReg, locationId: undefined };
      mockStore.getRegistration
        .mockResolvedValueOnce(regNoLocation)
        .mockResolvedValueOnce(regNoLocation);
      mockCatalogClient.addLocation.mockResolvedValue({
        location: { id: 'loc-new' },
      });
      mockFetchResponse(JSON.stringify(validOpenApi3));

      await service.refreshApi('reg-001');

      expect(mockCatalogClient.addLocation).toHaveBeenCalled();
      expect(mockStore.updateLocationId).toHaveBeenCalledWith('reg-001', 'loc-new');
    });

    it('throws when registration not found', async () => {
      mockStore.getRegistration.mockResolvedValue(undefined);

      await expect(service.refreshApi('nonexistent')).rejects.toThrow('not found');
    });
  });

  describe('getEntityYaml', () => {
    it('returns YAML for existing registration', async () => {
      mockStore.getRegistrationByName.mockResolvedValue({
        name: 'pet-store-api',
        specUrl: 'https://example.com/api.json',
        owner: 'team-a',
        lifecycle: 'production',
        tags: ['openapi', 'rest'],
      });
      mockFetchResponse(JSON.stringify(validOpenApi3));

      const yaml = await service.getEntityYaml('pet-store-api');

      expect(yaml).toBeDefined();
      expect(yaml).toContain('kind: API');
      expect(yaml).toContain('name: pet-store-api');
      expect(yaml).toContain('lifecycle: production');
    });

    it('returns null for non-existent registration', async () => {
      mockStore.getRegistrationByName.mockResolvedValue(undefined);

      const yaml = await service.getEntityYaml('nonexistent');
      expect(yaml).toBeNull();
    });

    it('returns null when spec fetch fails', async () => {
      mockStore.getRegistrationByName.mockResolvedValue({
        name: 'broken-api',
        specUrl: 'https://example.com/broken.json',
        owner: 'team-a',
        lifecycle: 'production',
      });
      mockFetchResponse('', { ok: false });

      const yaml = await service.getEntityYaml('broken-api');
      expect(yaml).toBeNull();
    });
  });

  describe('deleteRegistration', () => {
    it('removes from store and catalog', async () => {
      mockStore.getRegistration.mockResolvedValue({
        id: 'reg-001',
        name: 'pet-store-api',
        locationId: 'loc-abc',
      });

      await service.deleteRegistration('reg-001');

      expect(mockCatalogClient.removeLocationById).toHaveBeenCalledWith('loc-abc', { token: 'mock-token' });
      expect(mockStore.deleteRegistration).toHaveBeenCalledWith('reg-001');
    });

    it('skips catalog removal when no locationId', async () => {
      mockStore.getRegistration.mockResolvedValue({
        id: 'reg-001',
        name: 'pet-store-api',
        locationId: undefined,
      });

      await service.deleteRegistration('reg-001');

      expect(mockCatalogClient.removeLocationById).not.toHaveBeenCalled();
      expect(mockStore.deleteRegistration).toHaveBeenCalledWith('reg-001');
    });

    it('throws when registration not found', async () => {
      mockStore.getRegistration.mockResolvedValue(undefined);

      await expect(service.deleteRegistration('nonexistent')).rejects.toThrow('not found');
    });
  });
});
