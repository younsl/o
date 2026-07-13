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
  updateProgress: jest.fn(),
  revealPassword: jest.fn(),
};

const mockS3LogService = {
  listApps: jest.fn(),
  extractLogs: jest.fn(),
  countCandidateObjects: jest.fn(),
};

const mockExtractionQueue = {
  pump: jest.fn(),
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
    encryption: 'aes256',
    status: 'pending',
    reviewerRef: null,
    reviewComment: null,
    fileCount: null,
    archiveSize: null,
    archivePath: null,
    firstTimestamp: null,
    lastTimestamp: null,
    errorMessage: null,
    downloadable: false,
    passwordAvailable: false,
    passwordRevealedTo: null,
    passwordRevealedAt: null,
    approvalDeadline: '2026-03-06T00:00:00.000Z',
    extractionDurationMs: null,
    progressCurrent: null,
    progressTotal: null,
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
    extractionQueue: mockExtractionQueue as any,
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
        maxTimeRangeMinutes: 60,
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

  describe('GET /precheck', () => {
    const validQuery =
      'env=prd&date=2026-03-05&apps=order-api,payment-api&startTime=09:00&endTime=10:00';

    it('returns 400 when required params are missing', async () => {
      const res = await request(app).get('/precheck?env=prd&date=2026-03-05');
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('required');
    });

    it('returns 400 for invalid source', async () => {
      const res = await request(app).get(`/precheck?${validQuery}&source=lambda`);
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('source must be');
    });

    it('returns candidate counts', async () => {
      mockS3LogService.countCandidateObjects.mockResolvedValue({
        candidateCount: 12,
        scannedCount: 480,
        appCounts: { 'order-api': 12, 'payment-api': 0 },
      });

      const res = await request(app).get(`/precheck?${validQuery}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        candidateCount: 12,
        scannedCount: 480,
        appCounts: { 'order-api': 12, 'payment-api': 0 },
      });
      expect(mockS3LogService.countCandidateObjects).toHaveBeenCalledWith(
        'k8s',
        'prd',
        '2026-03-05',
        ['order-api', 'payment-api'],
        '09:00',
        '10:00',
      );
    });

    it('returns 500 when the S3 scan fails', async () => {
      mockS3LogService.countCandidateObjects.mockRejectedValue(
        new Error('Access Denied'),
      );

      const res = await request(app).get(`/precheck?${validQuery}`);

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
      encryption: 'aes256',
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

    // Use a dedicated app instance: the shared one's submit rate limiter
    // (max 5 per window) would return 429 for these extra POSTs.
    it('returns 400 when encryption is missing', async () => {
      setAuth('user:default/alice');
      const freshApp = await createTestApp();

      const res = await request(freshApp)
        .post('/requests')
        .send({ ...validBody, encryption: undefined });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('encryption');
    });

    it('returns 400 for unsupported encryption method', async () => {
      setAuth('user:default/alice');
      const freshApp = await createTestApp();

      const res = await request(freshApp)
        .post('/requests')
        .send({ ...validBody, encryption: 'zip20' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('encryption must be "aes256"');
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
      expect(mockExtractionQueue.pump).not.toHaveBeenCalled();
    });

    it('approves and queues the request for extraction', async () => {
      setAuth('user:default/admin');
      mockStore.getRequest.mockResolvedValue(makeRequest());
      mockStore.updateStatus.mockResolvedValue(
        makeRequest({ status: 'approved' }),
      );

      const res = await request(app)
        .post('/requests/req-001/review')
        .send({ action: 'approve', comment: 'Approved' });

      expect(res.status).toBe(200);
      expect(mockStore.updateStatus).toHaveBeenCalledWith('req-001', 'approved', {
        reviewerRef: 'user:default/admin',
        reviewComment: 'Approved',
      });
      // The queue owns the 'extracting' transition and the extraction itself.
      expect(mockStore.updateStatus).not.toHaveBeenCalledWith(
        'req-001',
        'extracting',
        expect.anything(),
      );
      expect(mockExtractionQueue.pump).toHaveBeenCalledTimes(1);
    });

    it('returns 500 and does not pump when recording the approval fails', async () => {
      setAuth('user:default/admin');
      mockStore.getRequest.mockResolvedValue(makeRequest());
      mockStore.updateStatus.mockRejectedValue(new Error('db down'));

      const res = await request(app)
        .post('/requests/req-001/review')
        .send({ action: 'approve', comment: 'ok' });

      expect(res.status).toBe(500);
      expect(mockExtractionQueue.pump).not.toHaveBeenCalled();
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

    it('returns 400 when the archive contains no logs', async () => {
      setAuth('user:default/alice');
      mockStore.getRequest.mockResolvedValue(
        makeRequest({
          status: 'completed',
          archivePath: '/tmp/test.zip',
          fileCount: 0,
        }),
      );

      const res = await request(app).get('/requests/req-001/download');

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('no logs');
    });
  });

  describe('POST /requests/:id/reveal-password', () => {
    const completed = () =>
      makeRequest({
        status: 'completed',
        archivePath: '/tmp/logs.zip',
        passwordAvailable: true,
      });

    it('returns 404 when request not found', async () => {
      setAuth('user:default/alice');
      mockStore.getRequest.mockResolvedValue(undefined);

      const res = await request(app).post('/requests/req-001/reveal-password');

      expect(res.status).toBe(404);
    });

    it('returns 403 when user is not the requester', async () => {
      setAuth('user:default/bob');
      mockStore.getRequest.mockResolvedValue(completed());

      const res = await request(app).post('/requests/req-001/reveal-password');

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('Only the requester');
      expect(mockStore.revealPassword).not.toHaveBeenCalled();
    });

    it('returns 400 when request is not completed', async () => {
      setAuth('user:default/alice');
      mockStore.getRequest.mockResolvedValue(makeRequest({ status: 'extracting' }));

      const res = await request(app).post('/requests/req-001/reveal-password');

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('not ready');
    });

    it('returns 400 when the archive contains no logs', async () => {
      setAuth('user:default/alice');
      mockStore.getRequest.mockResolvedValue(
        makeRequest({ ...completed(), fileCount: 0 }),
      );

      const res = await request(app).post('/requests/req-001/reveal-password');

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('no logs');
      expect(mockStore.revealPassword).not.toHaveBeenCalled();
    });

    it('reveals the password to the requester on first call', async () => {
      setAuth('user:default/alice');
      mockStore.getRequest.mockResolvedValue(completed());
      mockStore.revealPassword.mockResolvedValue('super-secret');

      const res = await request(app).post('/requests/req-001/reveal-password');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ password: 'super-secret' });
      expect(mockStore.revealPassword).toHaveBeenCalledWith(
        'req-001',
        'user:default/alice',
      );
    });

    it('allows admin to reveal', async () => {
      setAuth('user:default/admin');
      mockStore.getRequest.mockResolvedValue(completed());
      mockStore.revealPassword.mockResolvedValue('super-secret');

      const res = await request(app).post('/requests/req-001/reveal-password');

      expect(res.status).toBe(200);
    });

    it('returns 410 when password was already revealed', async () => {
      setAuth('user:default/alice');
      mockStore.getRequest.mockResolvedValue(
        makeRequest({
          status: 'completed',
          archivePath: '/tmp/logs.zip',
          passwordAvailable: false,
          passwordRevealedTo: 'user:default/alice',
          passwordRevealedAt: '2026-03-05T02:00:00.000Z',
        }),
      );
      mockStore.revealPassword.mockResolvedValue(null);

      const res = await request(app).post('/requests/req-001/reveal-password');

      expect(res.status).toBe(410);
      expect(res.body.error).toContain('already revealed');
      expect(res.body.revealedTo).toBe('user:default/alice');
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
