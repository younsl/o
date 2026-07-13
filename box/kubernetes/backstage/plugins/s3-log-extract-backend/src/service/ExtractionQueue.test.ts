import { ExtractionQueue } from './ExtractionQueue';
import { LogExtractRequest } from './types';

// The queue encrypts each completed archive; stub the encryptor so tests do
// not touch the filesystem and completion payloads stay deterministic.
jest.mock('./ArchiveEncryptor', () => ({
  generateArchivePassword: jest.fn(() => 'test-password'),
  encryptArchive: jest.fn(async () => ({
    zipPath: '/tmp/logs.zip',
    zipSize: 2048,
  })),
}));

const mockStore = {
  getOldestApproved: jest.fn(),
  updateStatus: jest.fn(),
  updateProgress: jest.fn(),
};

const mockS3LogService = {
  extractLogs: jest.fn(),
};

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  child: jest.fn().mockReturnThis(),
};

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
    status: 'approved',
    reviewerRef: 'user:default/admin',
    reviewComment: 'ok',
    fileCount: null,
    archiveSize: null,
    archivePath: null,
    firstTimestamp: null,
    lastTimestamp: null,
    errorMessage: null,
    downloadable: false,
    approvalDeadline: null,
    extractionDurationMs: null,
    progressCurrent: null,
    progressTotal: null,
    createdAt: '2026-03-05T00:00:00.000Z',
    updatedAt: '2026-03-05T00:00:00.000Z',
    ...overrides,
  };
}

const extractResult = {
  archivePath: '/tmp/logs.tar.gz',
  fileCount: 3,
  archiveSize: 1024,
  firstTimestamp: null,
  lastTimestamp: null,
};

function makeQueue(): ExtractionQueue {
  return new ExtractionQueue({
    store: mockStore as any,
    s3LogService: mockS3LogService as any,
    logger: mockLogger as any,
  });
}

/** Let the fire-and-forget drain loop settle. */
async function settle(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise(resolve => setImmediate(resolve));
  }
}

describe('ExtractionQueue', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockS3LogService.extractLogs.mockResolvedValue(extractResult);
    mockStore.updateProgress.mockResolvedValue(undefined);
  });

  it('runs queued requests one at a time in FIFO order', async () => {
    const reqA = makeRequest({ id: 'req-a' });
    const reqB = makeRequest({ id: 'req-b' });
    mockStore.getOldestApproved
      .mockResolvedValueOnce(reqA)
      .mockResolvedValueOnce(reqB)
      .mockResolvedValue(undefined);

    let active = 0;
    let maxActive = 0;
    mockS3LogService.extractLogs.mockImplementation(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise(resolve => setImmediate(resolve));
      active--;
      return extractResult;
    });

    makeQueue().pump();
    await settle();

    expect(mockS3LogService.extractLogs).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(1);

    const statusCalls = mockStore.updateStatus.mock.calls.map(
      ([id, status]) => `${id}:${status}`,
    );
    expect(statusCalls).toEqual([
      'req-a:extracting',
      'req-a:completed',
      'req-b:extracting',
      'req-b:completed',
    ]);
  });

  it('marks a failed extraction and continues with the next request', async () => {
    const reqA = makeRequest({ id: 'req-a' });
    const reqB = makeRequest({ id: 'req-b' });
    mockStore.getOldestApproved
      .mockResolvedValueOnce(reqA)
      .mockResolvedValueOnce(reqB)
      .mockResolvedValue(undefined);
    mockS3LogService.extractLogs
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(extractResult);

    makeQueue().pump();
    await settle();

    expect(mockStore.updateStatus).toHaveBeenCalledWith('req-a', 'failed', {
      errorMessage: 'boom',
    });
    expect(mockStore.updateStatus).toHaveBeenCalledWith(
      'req-b',
      'completed',
      expect.objectContaining({ fileCount: 3 }),
    );
  });

  it('ignores pump() while a drain is already running', async () => {
    let resolveExtract!: (value: typeof extractResult) => void;
    mockS3LogService.extractLogs.mockReturnValue(
      new Promise(resolve => {
        resolveExtract = resolve;
      }),
    );
    mockStore.getOldestApproved
      .mockResolvedValueOnce(makeRequest({ id: 'req-a' }))
      .mockResolvedValue(undefined);

    const queue = makeQueue();
    queue.pump();
    await settle(2);
    expect(mockS3LogService.extractLogs).toHaveBeenCalledTimes(1);

    // Extraction still in flight: another pump must not start a second drain.
    queue.pump();
    await settle(2);
    expect(mockStore.getOldestApproved).toHaveBeenCalledTimes(1);

    resolveExtract(extractResult);
    await settle();
    expect(mockStore.getOldestApproved).toHaveBeenCalledTimes(2);
    expect(mockS3LogService.extractLogs).toHaveBeenCalledTimes(1);
  });

  it('reports extraction progress on the request', async () => {
    mockStore.getOldestApproved
      .mockResolvedValueOnce(makeRequest({ id: 'req-a', apps: ['a', 'b'] }))
      .mockResolvedValue(undefined);
    mockS3LogService.extractLogs.mockImplementation(
      async (...args: unknown[]) => {
        const options = args[6] as {
          onProgress?: (current: number, total: number) => void;
        };
        options.onProgress?.(1, 2);
        return extractResult;
      },
    );

    makeQueue().pump();
    await settle();

    expect(mockStore.updateProgress).toHaveBeenCalledWith('req-a', 1, 2);
  });

  it('aborts the drain on a store error and recovers on the next pump', async () => {
    mockStore.getOldestApproved.mockRejectedValueOnce(new Error('db down'));

    const queue = makeQueue();
    queue.pump();
    await settle();

    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('drain aborted'),
    );

    // The draining flag must be released so a later pump can run.
    mockStore.getOldestApproved
      .mockResolvedValueOnce(makeRequest({ id: 'req-a' }))
      .mockResolvedValue(undefined);
    queue.pump();
    await settle();

    expect(mockS3LogService.extractLogs).toHaveBeenCalledTimes(1);
    expect(mockStore.updateStatus).toHaveBeenCalledWith(
      'req-a',
      'completed',
      expect.objectContaining({ fileCount: 3 }),
    );
  });
});
