import express from 'express';
import request from 'supertest';
import { ConfigReader } from '@backstage/config';
import { createRouter } from './router';
import { IamUserResponse, PasswordResetRequest } from './types';

const mockCache = {
  getUsers: jest.fn<IamUserResponse[], []>().mockReturnValue([]),
  getLastFetchedAt: jest.fn().mockReturnValue(null),
};

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  child: jest.fn().mockReturnThis(),
} as any;

const mockStore = {
  createRequest: jest.fn(),
  getRequest: jest.fn(),
  listRequests: jest.fn().mockResolvedValue([]),
  updateStatus: jest.fn(),
};

const mockIamUserService = {
  resetLoginProfile: jest.fn().mockResolvedValue(undefined),
};

const mockSlackNotifier = {
  notifyPasswordResetRequest: jest.fn().mockResolvedValue(undefined),
  notifyPasswordResetReview: jest.fn().mockResolvedValue(undefined),
  sendPasswordDm: jest.fn().mockResolvedValue(undefined),
  sendRejectionDm: jest.fn().mockResolvedValue(undefined),
};

const mockHttpAuth = {
  credentials: jest.fn(),
};

function makeUser(name: string, inactiveDays = 0): IamUserResponse {
  return {
    userName: name,
    userId: `AIDA${name.toUpperCase()}`,
    arn: `arn:aws:iam::123456789012:user/${name}`,
    createDate: '2024-01-01T00:00:00Z',
    passwordLastUsed: '2024-06-01T00:00:00Z',
    lastActivity: '2024-06-01T00:00:00Z',
    inactiveDays,
    accessKeyCount: 1,
    hasConsoleAccess: true,
    accessKeys: [],
  };
}

function makePendingRequest(overrides: Partial<PasswordResetRequest> = {}): PasswordResetRequest {
  return {
    id: 'req-001',
    iamUserName: 'johndoe',
    iamUserArn: 'arn:aws:iam::123456789012:user/johndoe',
    requesterRef: 'user:default/johndoe',
    requesterEmail: 'johndoe@example.com',
    reason: 'Forgot password',
    status: 'pending',
    reviewerRef: null,
    reviewComment: null,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

function setAuth(userRef: string) {
  mockHttpAuth.credentials.mockResolvedValue({
    principal: { userEntityRef: userRef },
  });
}

function setUnauthenticated() {
  mockHttpAuth.credentials.mockRejectedValue(new Error('Unauthorized'));
}

async function createTestApp(configOverrides: Record<string, any> = {}) {
  const config = new ConfigReader({
    permission: { admins: ['user:default/admin'] },
    ...configOverrides,
  });

  const router = await createRouter({
    cache: mockCache as any,
    logger: mockLogger,
    config,
    store: mockStore as any,
    iamUserService: mockIamUserService as any,
    slackNotifier: mockSlackNotifier as any,
    httpAuth: mockHttpAuth as any,
  });

  const app = express();
  app.use(router);
  return app;
}

describe('iam-user-audit-backend router', () => {
  let app: express.Express;

  beforeAll(async () => {
    app = await createTestApp();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockSlackNotifier.notifyPasswordResetRequest.mockResolvedValue(undefined);
    mockSlackNotifier.notifyPasswordResetReview.mockResolvedValue(undefined);
    mockSlackNotifier.sendPasswordDm.mockResolvedValue(undefined);
    mockSlackNotifier.sendRejectionDm.mockResolvedValue(undefined);
    mockIamUserService.resetLoginProfile.mockResolvedValue(undefined);
    mockStore.listRequests.mockResolvedValue([]);
    mockCache.getUsers.mockReturnValue([]);
  });

  describe('GET /status', () => {
    it('returns plugin status with config defaults', async () => {
      setAuth('user:default/admin');
      mockCache.getUsers.mockReturnValue([makeUser('alice', 100), makeUser('bob', 30)]);
      mockCache.getLastFetchedAt.mockReturnValue('2024-06-01T00:00:00Z');

      const res = await request(app).get('/status');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        enabled: true,
        inactiveDays: 90,
        cron: '0 10 * * 1-5',
        fetchCron: '0 * * * *',
        slackConfigured: false,
        lastFetchedAt: '2024-06-01T00:00:00Z',
        totalUsers: 2,
        inactiveUsers: 1,
      });
    });
  });

  describe('GET /health', () => {
    it('returns ok', async () => {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok' });
    });
  });

  describe('GET /users', () => {
    const users = [makeUser('johndoe', 100), makeUser('janedoe', 50)];

    it('returns all users for admin', async () => {
      setAuth('user:default/admin');
      mockCache.getUsers.mockReturnValue(users);

      const res = await request(app).get('/users');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
    });

    it('filters to own IAM user for regular user', async () => {
      setAuth('user:default/johndoe');
      mockCache.getUsers.mockReturnValue(users);

      const res = await request(app).get('/users');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].userName).toBe('johndoe');
    });

    it('returns 403 when unauthenticated', async () => {
      setUnauthenticated();

      const res = await request(app).get('/users');
      expect(res.status).toBe(403);
    });
  });

  describe('POST /password-reset/requests', () => {
    it('returns 400 when required fields are missing', async () => {
      setAuth('user:default/johndoe');

      const res = await request(app)
        .post('/password-reset/requests')
        .send({ iamUserName: 'johndoe' });

      expect(res.status).toBe(400);
    });

    it('creates request and returns 201', async () => {
      setAuth('user:default/johndoe');
      const pending = makePendingRequest();
      mockStore.createRequest.mockResolvedValue(pending);

      const res = await request(app)
        .post('/password-reset/requests')
        .send({
          iamUserName: 'johndoe',
          iamUserArn: 'arn:aws:iam::123456789012:user/johndoe',
          reason: 'Forgot password',
        });

      expect(res.status).toBe(201);
      expect(res.body.id).toBe('req-001');
      expect(mockSlackNotifier.notifyPasswordResetRequest).toHaveBeenCalledWith(pending);
    });
  });

  describe('GET /password-reset/requests', () => {
    const reqA = makePendingRequest({ id: 'req-001', requesterRef: 'user:default/johndoe' });
    const reqB = makePendingRequest({ id: 'req-002', requesterRef: 'user:default/janedoe' });

    it('returns all requests for admin', async () => {
      setAuth('user:default/admin');
      mockStore.listRequests.mockResolvedValue([reqA, reqB]);

      const res = await request(app).get('/password-reset/requests');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
    });

    it('filters to own requests for regular user', async () => {
      setAuth('user:default/johndoe');
      mockStore.listRequests.mockResolvedValue([reqA, reqB]);

      const res = await request(app).get('/password-reset/requests');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].id).toBe('req-001');
    });

    it('returns 403 when unauthenticated', async () => {
      setUnauthenticated();

      const res = await request(app).get('/password-reset/requests');
      expect(res.status).toBe(403);
    });
  });

  describe('GET /password-reset/requests/:id', () => {
    it('returns request by id', async () => {
      setAuth('user:default/johndoe');
      mockStore.getRequest.mockResolvedValue(makePendingRequest());

      const res = await request(app).get('/password-reset/requests/req-001');
      expect(res.status).toBe(200);
      expect(res.body.id).toBe('req-001');
    });

    it('returns 404 when not found', async () => {
      setAuth('user:default/johndoe');
      mockStore.getRequest.mockResolvedValue(undefined);

      const res = await request(app).get('/password-reset/requests/nonexistent');
      expect(res.status).toBe(404);
    });
  });

  describe('POST /password-reset/requests/:id/review', () => {
    it('returns 403 for non-admin', async () => {
      setAuth('user:default/johndoe');

      const res = await request(app)
        .post('/password-reset/requests/req-001/review')
        .send({ action: 'approve', comment: 'ok', newPassword: 'Pass123!' });

      expect(res.status).toBe(403);
    });

    it('returns 400 for invalid action', async () => {
      setAuth('user:default/admin');

      const res = await request(app)
        .post('/password-reset/requests/req-001/review')
        .send({ action: 'invalid', comment: 'test' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('action must be');
    });

    it('returns 400 when comment is missing', async () => {
      setAuth('user:default/admin');

      const res = await request(app)
        .post('/password-reset/requests/req-001/review')
        .send({ action: 'approve', newPassword: 'Pass123!' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('comment is required');
    });

    it('returns 409 when request is already processed', async () => {
      setAuth('user:default/admin');
      mockStore.getRequest.mockResolvedValue(
        makePendingRequest({ status: 'approved' }),
      );

      const res = await request(app)
        .post('/password-reset/requests/req-001/review')
        .send({ action: 'approve', comment: 'ok', newPassword: 'Pass123!' });

      expect(res.status).toBe(409);
    });

    it('returns 400 when approve lacks newPassword', async () => {
      setAuth('user:default/admin');
      mockStore.getRequest.mockResolvedValue(makePendingRequest());

      const res = await request(app)
        .post('/password-reset/requests/req-001/review')
        .send({ action: 'approve', comment: 'ok' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('newPassword is required');
    });

    it('calls resetLoginProfile on approve', async () => {
      setAuth('user:default/admin');
      mockStore.getRequest.mockResolvedValue(makePendingRequest());
      mockStore.updateStatus.mockResolvedValue(
        makePendingRequest({ status: 'approved', reviewerRef: 'user:default/admin' }),
      );

      const res = await request(app)
        .post('/password-reset/requests/req-001/review')
        .send({ action: 'approve', comment: 'Approved', newPassword: 'TempPass1!' });

      expect(res.status).toBe(200);
      expect(mockIamUserService.resetLoginProfile).toHaveBeenCalledWith('johndoe', 'TempPass1!');
      expect(mockSlackNotifier.sendPasswordDm).toHaveBeenCalledWith(
        'johndoe@example.com', 'johndoe', 'TempPass1!', 'req-001', 'user:default/admin',
      );
    });

    it('does not call resetLoginProfile on reject', async () => {
      setAuth('user:default/admin');
      mockStore.getRequest.mockResolvedValue(makePendingRequest());
      mockStore.updateStatus.mockResolvedValue(
        makePendingRequest({ status: 'rejected', reviewerRef: 'user:default/admin' }),
      );

      const res = await request(app)
        .post('/password-reset/requests/req-001/review')
        .send({ action: 'reject', comment: 'Not authorized' });

      expect(res.status).toBe(200);
      expect(mockIamUserService.resetLoginProfile).not.toHaveBeenCalled();
      expect(mockSlackNotifier.sendRejectionDm).toHaveBeenCalledWith(
        'johndoe@example.com', 'johndoe', 'req-001', 'user:default/admin', 'Not authorized',
      );
    });

    it('returns 404 when request does not exist', async () => {
      setAuth('user:default/admin');
      mockStore.getRequest.mockResolvedValue(undefined);

      const res = await request(app)
        .post('/password-reset/requests/nonexistent/review')
        .send({ action: 'approve', comment: 'ok', newPassword: 'Pass123!' });

      expect(res.status).toBe(404);
    });

    it('skips password DM when requesterEmail is empty on approve', async () => {
      setAuth('user:default/admin');
      mockStore.getRequest.mockResolvedValue(makePendingRequest({ requesterEmail: null }));
      mockStore.updateStatus.mockResolvedValue(
        makePendingRequest({ status: 'approved', requesterEmail: null }),
      );

      const res = await request(app)
        .post('/password-reset/requests/req-001/review')
        .send({ action: 'approve', comment: 'ok', newPassword: 'TempPass1!' });

      expect(res.status).toBe(200);
      expect(mockIamUserService.resetLoginProfile).toHaveBeenCalled();
      expect(mockSlackNotifier.sendPasswordDm).not.toHaveBeenCalled();
    });

    it('skips rejection DM when requesterEmail is empty on reject', async () => {
      setAuth('user:default/admin');
      mockStore.getRequest.mockResolvedValue(makePendingRequest({ requesterEmail: null }));
      mockStore.updateStatus.mockResolvedValue(
        makePendingRequest({ status: 'rejected', requesterEmail: null }),
      );

      const res = await request(app)
        .post('/password-reset/requests/req-001/review')
        .send({ action: 'reject', comment: 'Denied' });

      expect(res.status).toBe(200);
      expect(mockSlackNotifier.sendRejectionDm).not.toHaveBeenCalled();
    });

    it('returns 502 when AWS IAM fails', async () => {
      setAuth('user:default/admin');
      mockStore.getRequest.mockResolvedValue(makePendingRequest());
      mockIamUserService.resetLoginProfile.mockRejectedValue(
        new Error('AccessDenied'),
      );

      const res = await request(app)
        .post('/password-reset/requests/req-001/review')
        .send({ action: 'approve', comment: 'ok', newPassword: 'Pass123!' });

      expect(res.status).toBe(502);
      expect(res.body.error).toContain('AccessDenied');
    });

    it('skips AWS call in dryRun mode', async () => {
      const dryApp = await createTestApp({ iamUserAudit: { dryRun: true } });

      setAuth('user:default/admin');
      mockStore.getRequest.mockResolvedValue(makePendingRequest());
      mockStore.updateStatus.mockResolvedValue(
        makePendingRequest({ status: 'approved' }),
      );

      const res = await request(dryApp)
        .post('/password-reset/requests/req-001/review')
        .send({ action: 'approve', comment: 'ok', newPassword: 'Pass123!' });

      expect(res.status).toBe(200);
      expect(mockIamUserService.resetLoginProfile).not.toHaveBeenCalled();
    });
  });

  describe('GET /password-reset/admin-status', () => {
    it('returns true for admin', async () => {
      setAuth('user:default/admin');

      const res = await request(app).get('/password-reset/admin-status');
      expect(res.body).toEqual({ isAdmin: true });
    });

    it('returns false for regular user', async () => {
      setAuth('user:default/johndoe');

      const res = await request(app).get('/password-reset/admin-status');
      expect(res.body).toEqual({ isAdmin: false });
    });
  });
});
