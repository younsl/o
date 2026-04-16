import knex, { Knex } from 'knex';
import { OpenApiRegistryStore } from './OpenApiRegistryStore';

describe('OpenApiRegistryStore', () => {
  let db: Knex;
  let store: OpenApiRegistryStore;

  beforeEach(async () => {
    db = knex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
    });
    store = await OpenApiRegistryStore.create({ database: db });
  });

  afterEach(async () => {
    await db.destroy();
  });

  const baseRequest = {
    specUrl: 'https://example.com/openapi.json',
    name: 'test-api',
    title: 'Test API',
    owner: 'team-a',
    lifecycle: 'production',
  };

  it('creates and retrieves a registration', async () => {
    const created = await store.createRegistration(
      baseRequest,
      'api:default/test-api',
      'A test API',
    );

    expect(created.id).toBeDefined();
    expect(created.name).toBe('test-api');
    expect(created.specUrl).toBe('https://example.com/openapi.json');
    expect(created.entityRef).toBe('api:default/test-api');
    expect(created.description).toBe('A test API');

    const fetched = await store.getRegistration(created.id);
    expect(fetched).toBeDefined();
    expect(fetched!.name).toBe('test-api');
  });

  it('retrieves by name', async () => {
    await store.createRegistration(baseRequest, 'api:default/test-api');

    const found = await store.getRegistrationByName('test-api');
    expect(found).toBeDefined();
    expect(found!.specUrl).toBe('https://example.com/openapi.json');

    const notFound = await store.getRegistrationByName('nonexistent');
    expect(notFound).toBeUndefined();
  });

  it('retrieves by URL', async () => {
    await store.createRegistration(baseRequest, 'api:default/test-api');

    const found = await store.getRegistrationByUrl('https://example.com/openapi.json');
    expect(found).toBeDefined();
    expect(found!.name).toBe('test-api');
  });

  it('lists registrations ordered by created_at desc', async () => {
    await store.createRegistration(
      { ...baseRequest, specUrl: 'https://example.com/a.json', name: 'api-a' },
      'api:default/api-a',
    );
    // Small delay to ensure distinct timestamps
    await new Promise(r => setTimeout(r, 10));
    await store.createRegistration(
      { ...baseRequest, specUrl: 'https://example.com/b.json', name: 'api-b' },
      'api:default/api-b',
    );

    const list = await store.listRegistrations();
    expect(list).toHaveLength(2);
    expect(list[0].name).toBe('api-b');
    expect(list[1].name).toBe('api-a');
  });

  it('updates lastSyncedAt timestamp', async () => {
    const created = await store.createRegistration(baseRequest, 'api:default/test-api');
    const originalUpdatedAt = created.updatedAt;

    await new Promise(r => setTimeout(r, 10));
    await store.updateLastSyncedAt(created.id);

    const updated = await store.getRegistration(created.id);
    expect(updated!.updatedAt).not.toBe(originalUpdatedAt);
  });

  it('updates locationId', async () => {
    const created = await store.createRegistration(baseRequest, 'api:default/test-api');
    expect(created.locationId).toBeUndefined();

    await store.updateLocationId(created.id, 'loc-123');

    const updated = await store.getRegistration(created.id);
    expect(updated!.locationId).toBe('loc-123');
  });

  it('deletes a registration', async () => {
    const created = await store.createRegistration(baseRequest, 'api:default/test-api');
    await store.deleteRegistration(created.id);

    const deleted = await store.getRegistration(created.id);
    expect(deleted).toBeUndefined();
  });

  it('serializes and deserializes tags as JSON', async () => {
    const created = await store.createRegistration(
      { ...baseRequest, tags: ['openapi', 'rest', 'v3'] },
      'api:default/test-api',
    );

    const fetched = await store.getRegistration(created.id);
    expect(fetched!.tags).toEqual(['openapi', 'rest', 'v3']);
  });

  it('handles null tags', async () => {
    const created = await store.createRegistration(
      { ...baseRequest, tags: undefined },
      'api:default/test-api',
    );

    const fetched = await store.getRegistration(created.id);
    expect(fetched!.tags).toBeUndefined();
  });
});
