import knex, { Knex } from 'knex';
import { RequestStore } from './RequestStore';
import { CreateLogExtractInput } from './types';

describe('RequestStore', () => {
  let db: Knex;
  let store: RequestStore;

  const baseInput: CreateLogExtractInput = {
    source: 'k8s',
    env: 'prd',
    date: '2026-03-05',
    apps: ['order-api', 'payment-api'],
    startTime: '09:00',
    endTime: '10:00',
    reason: 'Investigate OOM errors',
  };

  beforeEach(async () => {
    db = knex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
    });
    store = await RequestStore.create({ database: db });
  });

  afterEach(async () => {
    await db.destroy();
  });

  describe('createRequest', () => {
    it('creates a request with pending status', async () => {
      const req = await store.createRequest(baseInput, 'user:default/alice');

      expect(req.id).toBeDefined();
      expect(req.source).toBe('k8s');
      expect(req.env).toBe('prd');
      expect(req.date).toBe('2026-03-05');
      expect(req.apps).toEqual(['order-api', 'payment-api']);
      expect(req.startTime).toBe('09:00');
      expect(req.endTime).toBe('10:00');
      expect(req.requesterRef).toBe('user:default/alice');
      expect(req.reason).toBe('Investigate OOM errors');
      expect(req.status).toBe('pending');
      expect(req.reviewerRef).toBeNull();
      expect(req.reviewComment).toBeNull();
      expect(req.fileCount).toBeNull();
      expect(req.archiveSize).toBeNull();
      expect(req.archivePath).toBeNull();
      expect(req.errorMessage).toBeNull();
    });

    it('stores apps as JSON and retrieves as array', async () => {
      const req = await store.createRequest(baseInput, 'user:default/alice');
      const fetched = await store.getRequest(req.id);

      expect(fetched).toBeDefined();
      expect(fetched!.apps).toEqual(['order-api', 'payment-api']);
    });

    it('creates ec2 source request', async () => {
      const req = await store.createRequest(
        { ...baseInput, source: 'ec2' },
        'user:default/bob',
      );

      expect(req.source).toBe('ec2');
    });
  });

  describe('getRequest', () => {
    it('returns undefined for non-existent id', async () => {
      const result = await store.getRequest('non-existent-id');
      expect(result).toBeUndefined();
    });

    it('retrieves request by id', async () => {
      const created = await store.createRequest(baseInput, 'user:default/alice');
      const fetched = await store.getRequest(created.id);

      expect(fetched).toBeDefined();
      expect(fetched!.id).toBe(created.id);
      expect(fetched!.env).toBe('prd');
    });
  });

  describe('listRequests', () => {
    it('returns empty array when no requests exist', async () => {
      const requests = await store.listRequests();
      expect(requests).toEqual([]);
    });

    it('returns requests ordered by created_at desc', async () => {
      const first = await store.createRequest(baseInput, 'user:default/alice');
      await new Promise(r => setTimeout(r, 10));
      const second = await store.createRequest(
        { ...baseInput, env: 'stg' },
        'user:default/bob',
      );

      const requests = await store.listRequests();

      expect(requests).toHaveLength(2);
      expect(requests[0].id).toBe(second.id);
      expect(requests[1].id).toBe(first.id);
    });
  });

  describe('updateStatus', () => {
    it('updates status to rejected with reviewer info', async () => {
      const created = await store.createRequest(baseInput, 'user:default/alice');

      const updated = await store.updateStatus(created.id, 'rejected', {
        reviewerRef: 'user:default/admin',
        reviewComment: 'Not enough detail',
      });

      expect(updated).toBeDefined();
      expect(updated!.status).toBe('rejected');
      expect(updated!.reviewerRef).toBe('user:default/admin');
      expect(updated!.reviewComment).toBe('Not enough detail');
    });

    it('updates status to completed with extraction results', async () => {
      const created = await store.createRequest(baseInput, 'user:default/alice');

      const updated = await store.updateStatus(created.id, 'completed', {
        fileCount: 42,
        archiveSize: 1024000,
        archivePath: '/tmp/logs.tar.gz',
        firstTimestamp: '2026-03-05T00:00:00.000Z',
        lastTimestamp: '2026-03-05T01:00:00.000Z',
      });

      expect(updated!.status).toBe('completed');
      expect(updated!.fileCount).toBe(42);
      expect(updated!.archiveSize).toBe(1024000);
      expect(updated!.archivePath).toBe('/tmp/logs.tar.gz');
      expect(updated!.firstTimestamp).toBe('2026-03-05T00:00:00.000Z');
      expect(updated!.lastTimestamp).toBe('2026-03-05T01:00:00.000Z');
    });

    it('updates status to failed with error message', async () => {
      const created = await store.createRequest(baseInput, 'user:default/alice');

      const updated = await store.updateStatus(created.id, 'failed', {
        errorMessage: 'S3 access denied',
      });

      expect(updated!.status).toBe('failed');
      expect(updated!.errorMessage).toBe('S3 access denied');
    });

    it('updates updated_at timestamp', async () => {
      const created = await store.createRequest(baseInput, 'user:default/alice');
      await new Promise(r => setTimeout(r, 10));

      const updated = await store.updateStatus(created.id, 'approved');

      expect(updated!.updatedAt).not.toBe(created.updatedAt);
    });

    it('returns undefined for non-existent id', async () => {
      const updated = await store.updateStatus('non-existent', 'approved');
      expect(updated).toBeUndefined();
    });
  });

  describe('rowToRequest edge cases', () => {
    it('handles corrupted apps JSON gracefully', async () => {
      const created = await store.createRequest(baseInput, 'user:default/alice');

      // Corrupt the apps column directly
      await db('log_extract_requests')
        .where({ id: created.id })
        .update({ apps: 'not-valid-json' });

      const fetched = await store.getRequest(created.id);
      expect(fetched!.apps).toEqual([]);
    });

    it('defaults source to k8s when null', async () => {
      const created = await store.createRequest(baseInput, 'user:default/alice');

      await db('log_extract_requests')
        .where({ id: created.id })
        .update({ source: null });

      const fetched = await store.getRequest(created.id);
      expect(fetched!.source).toBe('k8s');
    });
  });

  describe('table migration', () => {
    it('creates table on first initialization', async () => {
      const exists = await db.schema.hasTable('log_extract_requests');
      expect(exists).toBe(true);
    });

    it('second create call is idempotent', async () => {
      // Should not throw when table already exists
      const store2 = await RequestStore.create({ database: db });
      const requests = await store2.listRequests();
      expect(requests).toEqual([]);
    });
  });
});
