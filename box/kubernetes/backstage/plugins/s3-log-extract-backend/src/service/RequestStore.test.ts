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
    encryption: 'aes256',
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
      expect(req.encryption).toBe('aes256');
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

    it('stores null logType for k8s and for ec2 combo requests', async () => {
      const k8sReq = await store.createRequest(baseInput, 'user:default/alice');
      expect(k8sReq.logType).toBeNull();

      const ec2Req = await store.createRequest(
        { ...baseInput, source: 'ec2', apps: ['order-api/nginx'] },
        'user:default/bob',
      );
      expect(ec2Req.logType).toBeNull();

      const fetched = await store.getRequest(ec2Req.id);
      expect(fetched!.logType).toBeNull();
      expect(fetched!.apps).toEqual(['order-api/nginx']);
    });

    it('reads legacy ec2 rows (bare apps, no log_type) as java', async () => {
      const req = await store.createRequest(
        { ...baseInput, source: 'ec2' },
        'user:default/bob',
      );

      const fetched = await store.getRequest(req.id);
      expect(fetched!.logType).toBe('java');
    });

    it('persists a selected ec2 logType', async () => {
      const req = await store.createRequest(
        { ...baseInput, source: 'ec2', logType: 'nginx' },
        'user:default/bob',
      );
      const fetched = await store.getRequest(req.id);

      expect(fetched!.logType).toBe('nginx');
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

    it('derives extractionDurationMs from extracting to completed', async () => {
      const created = await store.createRequest(baseInput, 'user:default/alice');

      const extracting = await store.updateStatus(created.id, 'extracting');
      expect(extracting!.extractionDurationMs).toBeNull();

      await new Promise(r => setTimeout(r, 15));

      const completed = await store.updateStatus(created.id, 'completed', {
        fileCount: 1,
        archiveSize: 100,
        archivePath: '/tmp/logs.tar.gz',
      });

      expect(completed!.extractionDurationMs).not.toBeNull();
      expect(completed!.extractionDurationMs!).toBeGreaterThanOrEqual(0);
    });

    it('tracks progress counters', async () => {
      const created = await store.createRequest(baseInput, 'user:default/alice');

      await store.updateStatus(created.id, 'extracting', {
        progressCurrent: 0,
        progressTotal: 3,
      });
      await store.updateProgress(created.id, 2);

      const fetched = await store.getRequest(created.id);
      expect(fetched!.progressCurrent).toBe(2);
      expect(fetched!.progressTotal).toBe(3);
    });
  });

  describe('archive password lifecycle', () => {
    it('stores password on completion and exposes only passwordAvailable', async () => {
      const created = await store.createRequest(baseInput, 'user:default/alice');

      const updated = await store.updateStatus(created.id, 'completed', {
        archivePath: '/tmp/logs.zip',
        archivePassword: 'super-secret',
      });

      expect(updated!.passwordAvailable).toBe(true);
      expect(updated!.passwordRevealedTo).toBeNull();
      expect(updated!.passwordRevealedAt).toBeNull();
      // The plaintext password must never appear on the request object.
      expect(JSON.stringify(updated)).not.toContain('super-secret');
    });

    it('reveals the password exactly once and records the audit trail', async () => {
      const created = await store.createRequest(baseInput, 'user:default/alice');
      await store.updateStatus(created.id, 'completed', {
        archivePassword: 'super-secret',
      });

      const first = await store.revealPassword(created.id, 'user:default/alice');
      expect(first).toBe('super-secret');

      const second = await store.revealPassword(created.id, 'user:default/bob');
      expect(second).toBeNull();

      const fetched = await store.getRequest(created.id);
      expect(fetched!.passwordAvailable).toBe(false);
      expect(fetched!.passwordRevealedTo).toBe('user:default/alice');
      expect(fetched!.passwordRevealedAt).not.toBeNull();
    });

    it('returns null when no password was ever stored', async () => {
      const created = await store.createRequest(baseInput, 'user:default/alice');

      const result = await store.revealPassword(created.id, 'user:default/alice');
      expect(result).toBeNull();
    });

    it('returns null for non-existent request', async () => {
      const result = await store.revealPassword('non-existent', 'user:default/alice');
      expect(result).toBeNull();
    });
  });

  describe('getOldestApproved', () => {
    it('returns the earliest-approved request (FIFO by approval time)', async () => {
      const first = await store.createRequest(baseInput, 'user:default/alice');
      const second = await store.createRequest(baseInput, 'user:default/bob');

      // Approve in reverse creation order to prove ordering is by approval time.
      await store.updateStatus(second.id, 'approved');
      await new Promise(r => setTimeout(r, 10));
      await store.updateStatus(first.id, 'approved');

      const next = await store.getOldestApproved();
      expect(next!.id).toBe(second.id);
    });

    it('ignores requests in other statuses', async () => {
      const pending = await store.createRequest(baseInput, 'user:default/alice');
      const extracting = await store.createRequest(baseInput, 'user:default/bob');
      await store.updateStatus(extracting.id, 'extracting');

      expect(await store.getOldestApproved()).toBeUndefined();
      expect((await store.getRequest(pending.id))!.status).toBe('pending');
    });

    it('returns undefined when the queue is empty', async () => {
      expect(await store.getOldestApproved()).toBeUndefined();
    });
  });

  describe('failInterruptedExtractions', () => {
    it('marks extracting requests as failed', async () => {
      const created = await store.createRequest(baseInput, 'user:default/alice');
      await store.updateStatus(created.id, 'extracting');

      const count = await store.failInterruptedExtractions();

      expect(count).toBe(1);
      const fetched = await store.getRequest(created.id);
      expect(fetched!.status).toBe('failed');
      expect(fetched!.errorMessage).toContain('interrupted by service restart');
    });

    it('leaves requests in other statuses untouched', async () => {
      const pending = await store.createRequest(baseInput, 'user:default/alice');
      const completed = await store.createRequest(baseInput, 'user:default/bob');
      await store.updateStatus(completed.id, 'completed', {
        fileCount: 1,
        archiveSize: 100,
        archivePath: '/tmp/logs.tar.gz',
      });

      const count = await store.failInterruptedExtractions();

      expect(count).toBe(0);
      expect((await store.getRequest(pending.id))!.status).toBe('pending');
      expect((await store.getRequest(completed.id))!.status).toBe('completed');
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

    it('defaults logType to java for pre-migration ec2 rows', async () => {
      const created = await store.createRequest(
        { ...baseInput, source: 'ec2', logType: 'nginx' },
        'user:default/alice',
      );

      // Simulate a row written before the log_type column existed
      await db('log_extract_requests')
        .where({ id: created.id })
        .update({ log_type: null });

      const fetched = await store.getRequest(created.id);
      expect(fetched!.logType).toBe('java');
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

  describe('approvalDeadline', () => {
    it('returns deadline = createdAt + 24h for pending requests', async () => {
      const req = await store.createRequest(baseInput, 'user:default/alice');
      const expected = new Date(
        new Date(req.createdAt).getTime() + 24 * 60 * 60 * 1000,
      ).toISOString();
      expect(req.approvalDeadline).toBe(expected);
    });

    it('clears approvalDeadline once status leaves pending', async () => {
      const created = await store.createRequest(baseInput, 'user:default/alice');
      expect(created.approvalDeadline).not.toBeNull();

      const updated = await store.updateStatus(created.id, 'rejected', {
        reviewerRef: 'system:auto-reject',
        reviewComment: 'expired',
      });
      expect(updated!.approvalDeadline).toBeNull();
    });
  });

  describe('listPendingExpired', () => {
    it('returns pending requests older than 24h', async () => {
      const fresh = await store.createRequest(baseInput, 'user:default/alice');
      const old = await store.createRequest(baseInput, 'user:default/bob');

      // Backdate the second request by 25 hours
      const oldCreatedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      await db('log_extract_requests')
        .where({ id: old.id })
        .update({ created_at: oldCreatedAt });

      const expired = await store.listPendingExpired();
      expect(expired).toHaveLength(1);
      expect(expired[0].id).toBe(old.id);
      expect(expired.find(r => r.id === fresh.id)).toBeUndefined();
    });

    it('ignores non-pending requests even if old', async () => {
      const old = await store.createRequest(baseInput, 'user:default/alice');
      const oldCreatedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      await db('log_extract_requests')
        .where({ id: old.id })
        .update({ created_at: oldCreatedAt, status: 'approved' });

      const expired = await store.listPendingExpired();
      expect(expired).toEqual([]);
    });
  });
});
