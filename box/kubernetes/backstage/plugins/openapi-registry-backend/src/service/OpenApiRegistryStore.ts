import { Knex } from 'knex';
import { v4 as uuid } from 'uuid';
import { OpenApiRegistration, RegisterApiRequest } from './types';

const TABLE_NAME = 'openapi_registrations';

export interface OpenApiRegistryStoreOptions {
  database: Knex;
}

export class OpenApiRegistryStore {
  private readonly db: Knex;

  static async create(options: OpenApiRegistryStoreOptions): Promise<OpenApiRegistryStore> {
    const store = new OpenApiRegistryStore(options.database);
    await store.ensureTableExists();
    return store;
  }

  private constructor(database: Knex) {
    this.db = database;
  }

  private async ensureTableExists(): Promise<void> {
    const exists = await this.db.schema.hasTable(TABLE_NAME);
    if (!exists) {
      await this.db.schema.createTable(TABLE_NAME, table => {
        table.string('id').primary();
        table.string('spec_url').notNullable();
        table.string('entity_ref').notNullable();
        table.string('name').notNullable();
        table.string('title');
        table.text('description');
        table.string('owner').notNullable();
        table.string('lifecycle').notNullable();
        table.text('tags'); // JSON string
        table.string('location_id');
        table.timestamp('last_synced_at').notNullable();
        table.timestamp('created_at').notNullable();
        table.timestamp('updated_at').notNullable();
        table.unique(['spec_url']);
        table.unique(['name']);
      });
    }
  }

  async createRegistration(
    request: RegisterApiRequest,
    entityRef: string,
    description?: string,
    locationId?: string,
  ): Promise<OpenApiRegistration> {
    const now = new Date().toISOString();
    const registration: OpenApiRegistration = {
      id: uuid(),
      specUrl: request.specUrl,
      entityRef,
      name: request.name,
      title: request.title,
      description,
      owner: request.owner,
      lifecycle: request.lifecycle,
      tags: request.tags,
      locationId,
      lastSyncedAt: now,
      createdAt: now,
      updatedAt: now,
    };

    await this.db(TABLE_NAME).insert({
      id: registration.id,
      spec_url: registration.specUrl,
      entity_ref: registration.entityRef,
      name: registration.name,
      title: registration.title,
      description: registration.description,
      owner: registration.owner,
      lifecycle: registration.lifecycle,
      tags: registration.tags ? JSON.stringify(registration.tags) : null,
      location_id: registration.locationId,
      last_synced_at: registration.lastSyncedAt,
      created_at: registration.createdAt,
      updated_at: registration.updatedAt,
    });

    return registration;
  }

  async getRegistration(id: string): Promise<OpenApiRegistration | undefined> {
    const row = await this.db(TABLE_NAME).where({ id }).first();
    return row ? this.rowToRegistration(row) : undefined;
  }

  async getRegistrationByName(name: string): Promise<OpenApiRegistration | undefined> {
    const row = await this.db(TABLE_NAME).where({ name }).first();
    return row ? this.rowToRegistration(row) : undefined;
  }

  async getRegistrationByUrl(specUrl: string): Promise<OpenApiRegistration | undefined> {
    const row = await this.db(TABLE_NAME).where({ spec_url: specUrl }).first();
    return row ? this.rowToRegistration(row) : undefined;
  }

  async listRegistrations(): Promise<OpenApiRegistration[]> {
    const rows = await this.db(TABLE_NAME).orderBy('created_at', 'desc');
    return rows.map(row => this.rowToRegistration(row));
  }

  async updateLastSyncedAt(id: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db(TABLE_NAME)
      .where({ id })
      .update({
        last_synced_at: now,
        updated_at: now,
      });
  }

  async updateLocationId(id: string, locationId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db(TABLE_NAME)
      .where({ id })
      .update({
        location_id: locationId,
        updated_at: now,
      });
  }

  async updateRegistration(
    id: string,
    updates: Partial<Pick<OpenApiRegistration, 'title' | 'description'>>,
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.db(TABLE_NAME)
      .where({ id })
      .update({
        ...updates,
        updated_at: now,
      });
  }

  async deleteRegistration(id: string): Promise<void> {
    await this.db(TABLE_NAME).where({ id }).delete();
  }

  private rowToRegistration(row: Record<string, unknown>): OpenApiRegistration {
    return {
      id: row.id as string,
      specUrl: row.spec_url as string,
      entityRef: row.entity_ref as string,
      name: row.name as string,
      title: row.title as string | undefined,
      description: row.description as string | undefined,
      owner: row.owner as string,
      lifecycle: row.lifecycle as string,
      tags: row.tags ? JSON.parse(row.tags as string) : undefined,
      locationId: row.location_id as string | undefined,
      lastSyncedAt: row.last_synced_at as string,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }
}
