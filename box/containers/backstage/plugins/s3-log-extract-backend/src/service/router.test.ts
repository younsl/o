import express from 'express';
import request from 'supertest';
import { ConfigReader } from '@backstage/config';
import { createRouter } from './router';
import { LogExtractRequest, RequestStatus } from './types';

const mockStore = {
  createRequest: jest.fn(),
  getRequest: jest.fn(),
  listRequests: jest.fn(),
  updateStatus: jest.fn(),
};

const mockS3LogService = {
  listApps: jest.fn(),
  extractLogs: jest.fn(),
};

const mockHttpAuth = {
  credentials: jest.fn(),
  issueUserCookie: jest.fn(),
};

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  child: jest.fn().mockReturnThis(),
};

function setAuth(userRef: string) {
  mockHttpAuth.credentials.mockResolvedValue({
    principal: { userEntityRef: userRef },
  });
}

function setUnauthenticated() {
  mockHttpAuth.credentials.mockRejectedValue(new Error('Unauthorized'));
}

function makeRequest(overrides: Partial<LogExtractRequest> = {}): LogExtractRequest {
  return {
    id: 'req-001',
    source: 'k8s',
    env: 'prd',
    date: '2026-03-05',
    apps: ['order-api'],
    startTime: '09:00',
    endTime: '10:00',
    requesterRef: 'user:default/alice',
    reason: 'Investigate errors',
    status: 'pending',
    reviewerRef: null,
    reviewComment: null,
    fileCount: null,
    archiveSize: null,
    archivePath: null,
    firstTimestamp: null,
    lastTimestamp: null,
    errorMessage: null,
    createdAt: '2026-03-05T00:00:00.000Z',
    updatedAt: '2026-03-05T00:00:00.000Z',
    ...overrides,
  };
}

async function createTestApp(configOverrides: Record<string, unknown> = {}) {
  const config = new ConfigReader({
    permission: { admins: ['user:default/admin'] },
    s3LogExtract: {
      bucket: 'test-bucket',
      region: 'ap-northeast-2',
      prefix: 'app-logs',
    },
    ...configOverrides,
  });

  const router = await createRouter({
    config,
    logger: mockLogger as any,
    store: mockStore as any,
    s3LogService: mockS3LogService as any,
    httpAuth: mockHttpAuth as any,
  });

  const app = express();
  app.use(router);
  return app;
}

describe('router', () => {
  let app: express.Express;

  beforeAll(async () => {
    app = await createTestApp();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /health', () => {
    it('returns ok', async () => {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok' });
    });
  });

  describe('GET /config', () => {
    it('returns S3 configuration', async () => {
      const res = await request(app).get('/config');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        bucket: 'test-bucket',
        region: 'ap-northeast-2',
        prefix: 'app-logs',
      });
    });
  });

  describe('GET /apps', () => {
    it('returns 400 when env is missing', async () => {
      const res = await request(app).get('/apps?date=2026-03-05');
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('env and date are required');
    });

    it('returns 400 when date is missing', async () => {
      const res = await request(app).get('/apps?env=prd');
      expect(res.status).toBe(400);
    });

    it('returns 400 for invalid source', async () => {
      const res = await request(app).get('/apps?env=prd&date=2026-03-05&source=invalid');
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('source must be');
    });

    it('lists apps with default k8s source', async () => {
      mockS3LogService.listApps.mockResolvedValue(['order-api', 'payment-api']);

      const res = await request(app).get('/apps?env=prd&date=2026-03-05');

      expect(res.status).toBe(200);
      expect(res.body).toEqual(['order-api', 'payment-api']);
      expect(mockS3LogService.listApps).toHaveBeenCalledWith('prd', '2026-03-05', 'k8s');
    });

    it('lists apps with ec2 source', async () => {
      mockS3LogService.listApps.mockResolvedValue(['web-app']);

      const res = await request(app).get('/apps?env=stg&date=2026-03-05&source=ec2');

      expect(res.status).toBe(200);
      expect(mockS3LogService.listApps).toHaveBeenCalledWith('stg', '2026-03-05', 'ec2');
    });

    it('returns 500 when S3 service fails', async () => {
      mockS3LogService.listApps.mockRejectedValue(new Error('Access Denied'));

      const res = await request(app).get('/apps?env=prd&date=2026-03-05');

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Access Denied');
    });
  });

  describe('POST /requests', () => {
    const validBody = {
      source: 'k8s',
      env: 'prd',
      date: '2026-03-05',
      apps: ['order-api'],
      startTime: '09:00',
      endTime: '10:00',
      reason: 'Investigate errors',
    };

    it('creates a request and returns 201', async () => {
      setAuth('user:default/alice');
      mockStore.createRequest.mockResolvedValue(makeRequest());

      const res = await request(app).post('/requests').send(validBody);

      expect(res.status).toBe(201);
      expect(res.body.id).toBe('req-001');
      expect(mockStore.createRequest).toHaveBeenCalledWith(validBody, 'user:default/alice');
    });

    it('returns 400 when required fields are missing', async () => {
      setAuth('user:default/alice');

      const res = await request(app).post('/requests').send({ env: 'prd' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('required');
    });

    it('returns 400 for empty apps array', async () => {
      setAuth('user:default/alice');

      const res = await request(app).post('/requests').send({ ...validBody, apps: [] });

      expect(res.status).toBe(400);
    });

    it('returns 400 for invalid source', async () => {
      setAuth('user:default/alice');

      const res = await request(app)
        .post('/requests')
        .send({ ...validBody, source: 'lambda' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('source must be');
    });

    it('falls back to unknown user when unauthenticated', async () => {
      setUnauthenticated();
      mockStore.createRequest.mockResolvedValue(
        makeRequest({ requesterRef: 'user:default/unknown' }),
      );

      const appWithDevMode = await createTestApp({
        backend: { auth: { dangerouslyDisableDefaultAuthPolicy: false } },
      });

      const res = await request(appWithDevMode).post('/requests').send(validBody);

      expect(res.status).toBe(201);
      expect(mockStore.createRequest).toHaveBeenCalledWith(
        validBody,
        'user:default/unknown',
      );
    });
  });

  describe('GET /requests', () => {
    it('returns all requests for admin', async () => {
      setAuth('user:default/admin');
      const requests = [makeRequest(), makeRequest({ id: 'req-002' })];
      mockStore.listRequests.mockResolvedValue(requests);

      const res = await request(app).get('/requests');

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
    });

    it('returns all requests for guest user', async () => {
      setAuth('user:default/guest');
      const requests = [makeRequest()];
      mockStore.listRequests.mockResolvedValue(requests);

      const res = await request(app).get('/requests');

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
    });

    it('filters requests for non-admin user', async () => {
      setAuth('user:default/alice');
      const requests = [
        makeRequest({ requesterRef: 'user:default/alice' }),
        makeRequest({ id: 'req-002', requesterRef: 'user:default/bob' }),
      ];
      mockStore.listRequests.mockResolvedValue(requests);

      const res = await request(app).get('/requests');

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].requesterRef).toBe('user:default/alice');
    });

    it('returns 403 for unauthenticated users', async () => {
      setUnauthenticated();
      mockStore.listRequests.mockResolvedValue([]);

      const res = await request(app).get('/requests');

      expect(res.status).toBe(403);
    });
  });

  describe('GET /requests/:id', () => {
    it('returns a request by id', async () => {
      mockStore.getRequest.mockResolvedValue(makeRequest());

      const res = await request(app).get('/requests/req-001');

      expect(res.status).toBe(200);
      expect(res.body.id).toBe('req-001');
    });

    it('returns 404 for non-existent request', async () => {
      mockStore.getRequest.mockResolvedValue(undefined);

      const res = await request(app).get('/requests/non-existent');

      expect(res.status).toBe(404);
    });
  });

  describe('POST /requests/:id/review', () => {
    it('returns 403 for non-admin', async () => {
      setAuth('user:default/alice');

      const res = await request(app)
        .post('/requests/req-001/review')
        .send({ action: 'approve', comment: 'ok' });

      expect(res.status).toBe(403);
    });

    it('returns 403 for unauthenticated user', async () => {
      setUnauthenticated();

      const res = await request(app)
        .post('/requests/req-001/review')
        .send({ action: 'approve', comment: 'ok' });

      expect(res.status).toBe(403);
    });

    it('returns 400 for invalid action', async () => {
      setAuth('user:default/admin');

      const res = await request(app)
        .post('/requests/req-001/review')
        .send({ action: 'maybe', comment: 'unsure' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('action must be');
    });

    it('returns 400 when comment is empty', async () => {
      setAuth('user:default/admin');

      const res = await request(app)
        .post('/requests/req-001/review')
        .send({ action: 'approve', comment: '  ' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('comment is required');
    });

    it('returns 404 when request not found', async () => {
      setAuth('user:default/admin');
      mockStore.getRequest.mockResolvedValue(undefined);

      const res = await request(app)
        .post('/requests/req-001/review')
        .send({ action: 'approve', comment: 'ok' });

      expect(res.status).toBe(404);
    });

    it('returns 409 when request is not pending', async () => {
      setAuth('user:default/admin');
      mockStore.getRequest.mockResolvedValue(makeRequest({ status: 'approved' }));

      const res = await request(app)
        .post('/requests/req-001/review')
        .send({ action: 'approve', comment: 'ok' });

      expect(res.status).toBe(409);
      expect(res.body.error).toContain('already approved');
    });

    it('rejects a pending request', async () => {
      setAuth('user:default/admin');
      mockStore.getRequest.mockResolvedValue(makeRequest());
      mockStore.updateStatus.mockResolvedValue(
        makeRequest({ status: 'rejected', reviewerRef: 'user:default/admin' }),
      );

      const res = await request(app)
        .post('/requests/req-001/review')
        .send({ action: 'reject', comment: 'Insufficient detail' });

      expect(res.status).toBe(200);
      expect(mockStore.updateStatus).toHaveBeenCalledWith('req-001', 'rejected', {
        reviewerRef: 'user:default/admin',
        reviewComment: 'Insufficient detail',
      });
    });

    it('approves and triggers extraction', async () => {
      setAuth('user:default/admin');
      const pending = makeRequest();
      mockStore.getRequest.mockResolvedValue(pending);
      mockStore.updateStatus.mockResolvedValue(
        makeRequest({ status: 'extracting' }),
      );
      // extractLogs returns a never-resolving promise to avoid race conditions in test
      mockS3LogService.extractLogs.mockReturnValue(new Promise(() => {}));

      const res = await request(app)
        .post('/requests/req-001/review')
        .send({ action: 'approve', comment: 'Approved' });

      expect(res.status).toBe(200);
      expect(mockStore.updateStatus).toHaveBeenCalledWith('req-001', 'approved', {
        reviewerRef: 'user:default/admin',
        reviewComment: 'Approved',
      });
      expect(mockStore.updateStatus).toHaveBeenCalledWith('req-001', 'extracting');
      expect(mockS3LogService.extractLogs).toHaveBeenCalledWith(
        'k8s',
        'prd',
        '2026-03-05',
        ['order-api'],
        '09:00',
        '10:00',
      );
    });
  });

  describe('GET /requests/:id/download', () => {
    it('returns 404 when request not found', async () => {
      setAuth('user:default/alice');
      mockStore.getRequest.mockResolvedValue(undefined);

      const res = await request(app).get('/requests/req-001/download');

      expect(res.status).toBe(404);
    });

    it('returns 400 when request is not completed', async () => {
      setAuth('user:default/alice');
      mockStore.getRequest.mockResolvedValue(makeRequest({ status: 'pending' }));

      const res = await request(app).get('/requests/req-001/download');

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('not ready');
    });

    it('returns 403 when user is not the requester', async () => {
      setAuth('user:default/bob');
      mockStore.getRequest.mockResolvedValue(
        makeRequest({
          status: 'completed',
          archivePath: '/tmp/test.tar.gz',
          requesterRef: 'user:default/alice',
        }),
      );

      const res = await request(app).get('/requests/req-001/download');

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('Only the requester');
    });
  });

  describe('GET /admin-status', () => {
    it('returns isAdmin true for admin user', async () => {
      setAuth('user:default/admin');

      const res = await request(app).get('/admin-status');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ isAdmin: true });
    });

    it('returns isAdmin false for non-admin user', async () => {
      setAuth('user:default/alice');

      const res = await request(app).get('/admin-status');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ isAdmin: false });
    });

    it('returns isAdmin false when unauthenticated', async () => {
      setUnauthenticated();

      const res = await request(app).get('/admin-status');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ isAdmin: false });
    });
  });
});
