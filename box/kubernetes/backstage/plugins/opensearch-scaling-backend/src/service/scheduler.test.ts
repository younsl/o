import { registerScheduler } from './scheduler';

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  child: jest.fn().mockReturnThis(),
} as any;

// Current domain config the reservations scale up from: r6g.xlarge.search x3, 1200GB.
const DOMAIN = 'shared-log-opensearch';

/**
 * Wires registerScheduler with mock client/store/scheduler so no real AWS call
 * is made, captures the scheduled task function, and runs one tick.
 */
async function runTick(reservation: any) {
  let task: () => Promise<void> = async () => {};
  const scheduler = {
    scheduleTask: jest.fn(async (opts: any) => {
      task = opts.fn;
    }),
  } as any;

  const client = {
    isChangeInProgress: jest.fn().mockResolvedValue(false),
    updateScaling: jest.fn().mockResolvedValue(undefined),
  } as any;

  const store = {
    listDue: jest.fn().mockResolvedValue([reservation]),
    listInProgress: jest.fn().mockResolvedValue([]),
    updateStatus: jest.fn().mockResolvedValue(undefined),
  } as any;

  await registerScheduler({
    logger: mockLogger,
    scheduler,
    store,
    client,
    graceHours: 2,
  });
  await task();

  return { client, store };
}

describe('opensearch-scaling scheduler executes the scaling call (mocked AWS)', () => {
  it('scenario 1: instance type scale-up with the same node count (Blue/Green)', async () => {
    // 노드 3대 유지, 타입만 r6g.xlarge -> r6g.2xlarge 로 스펙 업그레이드
    const reservation = {
      id: 'r1',
      domain: DOMAIN,
      instanceType: 'r6g.2xlarge.search',
      instanceCount: 3,
      volumeSizeGb: 1200,
      scheduledAt: '2020-01-01T00:00:00.000Z',
    };

    const { client, store } = await runTick(reservation);

    // Pre-execution re-validation runs, then UpdateDomainConfig is called once
    // with exactly the reserved target (count unchanged, type upgraded).
    expect(client.isChangeInProgress).toHaveBeenCalledWith(DOMAIN);
    expect(client.updateScaling).toHaveBeenCalledTimes(1);
    expect(client.updateScaling).toHaveBeenCalledWith(DOMAIN, {
      instanceType: 'r6g.2xlarge.search',
      instanceCount: 3,
      volumeSizeGb: 1200,
    });
    expect(store.updateStatus).toHaveBeenCalledWith('r1', 'validating');
    expect(store.updateStatus).toHaveBeenCalledWith(
      'r1',
      'in_progress',
      expect.objectContaining({
        event: expect.objectContaining({ type: 'executed' }),
      }),
    );
  });

  it('scenario 2: EBS volume increase with the same instance type and count (Dynamic in-place)', async () => {
    // 타입/대수 동일(r6g.xlarge x3), 노드당 EBS 1200 -> 2400GB 용량 증설
    const reservation = {
      id: 'r2',
      domain: DOMAIN,
      instanceType: 'r6g.xlarge.search',
      instanceCount: 3,
      volumeSizeGb: 2400,
      scheduledAt: '2020-01-01T00:00:00.000Z',
    };

    const { client, store } = await runTick(reservation);

    expect(client.updateScaling).toHaveBeenCalledTimes(1);
    expect(client.updateScaling).toHaveBeenCalledWith(DOMAIN, {
      instanceType: 'r6g.xlarge.search',
      instanceCount: 3,
      volumeSizeGb: 2400,
    });
    expect(store.updateStatus).toHaveBeenCalledWith(
      'r2',
      'in_progress',
      expect.anything(),
    );
  });
});
