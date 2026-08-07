import express from 'express';
import request from 'supertest';
import { ConfigReader } from '@backstage/config';
import { createRouter } from './router';

const logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  child: jest.fn().mockReturnThis(),
} as any;

const ADMIN = 'user:default/alice';
const NON_ADMIN = 'user:default/bob';
const DOMAIN = 'shared-log-opensearch';
// Far-future so the (mocked) backend never executes anything real.
const FUTURE = '2099-12-31T00:00:00.000Z';

// Current domain config the reservations scale up from.
const CURRENT = {
  name: DOMAIN,
  instanceType: 'r6g.xlarge.search',
  instanceCount: 3,
  volumeSizeGb: 1200,
  engineVersion: 'OpenSearch_2.17',
  processing: false,
  upgradeProcessing: false,
};

async function makeApp(opts: {
  user?: string;
  admins?: string[];
  client?: any;
  store?: any;
}) {
  const config = new ConfigReader({
    permission: { admins: opts.admins ?? [ADMIN] },
  });
  const httpAuth = {
    credentials: jest.fn(async () => {
      if (!opts.user) throw new Error('no user');
      return { principal: { userEntityRef: opts.user } };
    }),
  } as any;
  const router = await createRouter({
    logger,
    config,
    httpAuth,
    store: opts.store ?? {},
    client: opts.client ?? {},
    instanceTypes: ['r6g.large.search', 'r6g.xlarge.search'],
    timezones: ['Asia/Seoul', 'UTC'],
    defaultTimezone: 'Asia/Seoul',
  });
  const app = express();
  app.use(router);
  return app;
}

describe('opensearch-scaling router (mocked AWS, no real OpenSearch calls)', () => {
  describe('GET /config and /user-role', () => {
    it('returns config', async () => {
      const app = await makeApp({ user: ADMIN });
      const res = await request(app).get('/config').expect(200);
      expect(res.body).toMatchObject({
        configured: true,
        defaultTimezone: 'Asia/Seoul',
      });
      expect(res.body.timezones).toContain('UTC');
    });

    it('reports admin role', async () => {
      const app = await makeApp({ user: ADMIN });
      const res = await request(app).get('/user-role').expect(200);
      expect(res.body.isAdmin).toBe(true);
    });

    it('reports non-admin role', async () => {
      const app = await makeApp({ user: NON_ADMIN });
      const res = await request(app).get('/user-role').expect(200);
      expect(res.body.isAdmin).toBe(false);
    });
  });

  describe('POST /requests (create reservation, admin only)', () => {
    const body = {
      domain: DOMAIN,
      instanceType: 'r6g.2xlarge.search',
      instanceCount: 3,
      volumeSizeGb: 1200,
      scheduledAt: FUTURE,
      timezone: 'Asia/Seoul',
      reason: 'Black Friday scale-up',
    };

    it('creates a reservation when the domain is idle (201)', async () => {
      const client = {
        describeDomain: jest.fn().mockResolvedValue(CURRENT),
        isChangeInProgress: jest.fn().mockResolvedValue(false),
      };
      const store = {
        hasActiveRequest: jest.fn().mockResolvedValue(false),
        addRequest: jest.fn().mockResolvedValue({ id: 'r1', ...body }),
      };
      const app = await makeApp({ user: ADMIN, client, store });

      await request(app).post('/requests').send(body).expect(201);
      expect(store.addRequest).toHaveBeenCalledTimes(1);
      expect(store.addRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          domain: DOMAIN,
          instanceType: 'r6g.2xlarge.search',
          instanceCount: 3,
          volumeSizeGb: 1200,
          requester: ADMIN,
        }),
      );
    });

    it('rejects when a change is already in progress (409)', async () => {
      const client = {
        describeDomain: jest.fn().mockResolvedValue(CURRENT),
        isChangeInProgress: jest.fn().mockResolvedValue(true),
      };
      const store = {
        hasActiveRequest: jest.fn().mockResolvedValue(false),
        addRequest: jest.fn(),
      };
      const app = await makeApp({ user: ADMIN, client, store });

      await request(app).post('/requests').send(body).expect(409);
      expect(store.addRequest).not.toHaveBeenCalled();
    });

    it('rejects a past reservation time (400)', async () => {
      const app = await makeApp({ user: ADMIN, client: {}, store: {} });
      await request(app)
        .post('/requests')
        .send({ ...body, scheduledAt: '2000-01-01T00:00:00.000Z' })
        .expect(400);
    });

    it('forbids non-admins (403)', async () => {
      const client = { describeDomain: jest.fn(), isChangeInProgress: jest.fn() };
      const app = await makeApp({ user: NON_ADMIN, client, store: {} });
      await request(app).post('/requests').send(body).expect(403);
      expect(client.describeDomain).not.toHaveBeenCalled();
    });
  });

  describe('POST /domains/:name/preview (dry-run, admin only)', () => {
    it('returns Blue/Green for an instance type change', async () => {
      const client = {
        dryRunScaling: jest
          .fn()
          .mockResolvedValue({ deploymentType: 'Blue/Green', message: null }),
      };
      const app = await makeApp({ user: ADMIN, client });
      const res = await request(app)
        .post(`/domains/${DOMAIN}/preview`)
        .send({ instanceType: 'r6g.2xlarge.search', instanceCount: 3, volumeSizeGb: 1200 })
        .expect(200);
      expect(res.body.deploymentType).toBe('Blue/Green');
      expect(client.dryRunScaling).toHaveBeenCalledWith(DOMAIN, {
        instanceType: 'r6g.2xlarge.search',
        instanceCount: 3,
        volumeSizeGb: 1200,
      });
    });

    it('returns DynamicUpdate for an EBS volume increase', async () => {
      const client = {
        dryRunScaling: jest
          .fn()
          .mockResolvedValue({ deploymentType: 'DynamicUpdate', message: null }),
      };
      const app = await makeApp({ user: ADMIN, client });
      const res = await request(app)
        .post(`/domains/${DOMAIN}/preview`)
        .send({ instanceType: 'r6g.xlarge.search', instanceCount: 3, volumeSizeGb: 2400 })
        .expect(200);
      expect(res.body.deploymentType).toBe('DynamicUpdate');
    });

    it('forbids non-admins (403)', async () => {
      const client = { dryRunScaling: jest.fn() };
      const app = await makeApp({ user: NON_ADMIN, client });
      await request(app)
        .post(`/domains/${DOMAIN}/preview`)
        .send({ instanceType: 'r6g.2xlarge.search', instanceCount: 3, volumeSizeGb: 1200 })
        .expect(403);
      expect(client.dryRunScaling).not.toHaveBeenCalled();
    });
  });

  describe('POST /requests/:id/cancel (admin only)', () => {
    it('cancels a scheduled reservation', async () => {
      const store = {
        getRequest: jest
          .fn()
          .mockResolvedValue({ id: 'r1', requester: ADMIN, status: 'scheduled' }),
        updateStatus: jest
          .fn()
          .mockResolvedValue({ id: 'r1', status: 'cancelled' }),
      };
      const app = await makeApp({ user: ADMIN, store });
      const res = await request(app).post('/requests/r1/cancel').expect(200);
      expect(res.body.status).toBe('cancelled');
      expect(store.updateStatus).toHaveBeenCalledWith(
        'r1',
        'cancelled',
        expect.anything(),
      );
    });

    it('forbids non-admins (403)', async () => {
      const store = { getRequest: jest.fn(), updateStatus: jest.fn() };
      const app = await makeApp({ user: NON_ADMIN, store });
      await request(app).post('/requests/r1/cancel').expect(403);
      expect(store.updateStatus).not.toHaveBeenCalled();
    });
  });
});
