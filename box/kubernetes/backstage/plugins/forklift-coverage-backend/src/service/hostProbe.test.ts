import {
  isValidProbeTarget,
  normalizeHost,
  probeHost,
  validateHost,
} from './hostProbe';

jest.mock('node-fetch', () => jest.fn());
const fetchMock = jest.requireMock('node-fetch') as jest.Mock;

describe('normalizeHost', () => {
  it.each([
    ['  forklift.example.com  ', 'forklift.example.com'],
    ['https://forklift.example.com/', 'forklift.example.com'],
    ['HTTP://forklift.example.com///', 'forklift.example.com'],
    ['forklift.example.com:8443', 'forklift.example.com:8443'],
  ])('normalizes %s', (raw, expected) => {
    expect(normalizeHost(raw)).toBe(expected);
  });

  it('strips a long run of trailing slashes in linear time', () => {
    const start = Date.now();
    expect(normalizeHost(`forklift.example.com${'/'.repeat(100_000)}`)).toBe(
      'forklift.example.com',
    );
    expect(Date.now() - start).toBeLessThan(1_000);
  });
});

describe('isValidProbeTarget', () => {
  it.each([
    'forklift.example.com',
    'forklift.example.com:8443',
    'forklift.forklift.svc.cluster.local',
  ])('accepts %s', host => {
    expect(isValidProbeTarget(host)).toBe(true);
  });

  it.each([
    'forklift',
    'localhost',
    '127.0.0.1',
    '169.254.169.254',
    'example..com',
    'example.com.',
    'example.com:abc',
    'example.com:8443:9000',
    'example.com:70000',
    `${'a'.repeat(64)}.example.com`,
    `${'a.'.repeat(130)}com`,
    '',
  ])('rejects %s', host => {
    expect(isValidProbeTarget(host)).toBe(false);
  });

  it('rejects adversarial input without catastrophic backtracking', () => {
    const start = Date.now();
    expect(isValidProbeTarget(`${'a-'.repeat(50_000)}.com`)).toBe(false);
    expect(Date.now() - start).toBeLessThan(1_000);
  });
});

describe('validateHost', () => {
  it.each([
    'forklift.example.com',
    'forklift.example.com:8443',
    'FORKLIFT.Example.COM',
    'my-forklift.sub.example.co.kr',
    'forklift.forklift.svc.cluster.local',
    'https://forklift.example.com/',
  ])('accepts %s', host => {
    expect(validateHost(host)).toBeNull();
  });

  it.each([
    ['', 'Host is required'],
    ['forklift.example.com/coverage', 'no scheme or path'],
    ['user@forklift.example.com', 'no scheme or path'],
    ['forklift', 'not an IP address'],
    ['localhost', 'not an IP address'],
    ['127.0.0.1', 'not an IP address'],
    ['169.254.169.254', 'not an IP address'],
    ['10.0.0.5:8080', 'not an IP address'],
    ['ex_ample.com', 'not an IP address'],
    ['forklift.example.com:70000', 'Port is out of range'],
  ])('rejects %s', (host, message) => {
    expect(validateHost(host)).toContain(message);
  });
});

describe('probeHost', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('reports any HTTP status as reachable', async () => {
    fetchMock.mockResolvedValue({ status: 401 });

    const result = await probeHost('forklift.example.com');

    expect(result).toMatchObject({ reachable: true, status: 401, error: null });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://forklift.example.com/',
      expect.objectContaining({ method: 'GET', redirect: 'manual' }),
    );
  });

  it('reports a transport failure as unreachable', async () => {
    fetchMock.mockRejectedValue(new Error('ENOTFOUND'));

    const result = await probeHost('forklift.example.com');

    expect(result).toMatchObject({ reachable: false, status: null });
    expect(result.error).toContain('ENOTFOUND');
  });

  // The host reaches `fetch` from a request body, so probeHost has to refuse an
  // invalid target itself rather than rely on the caller having validated it.
  it.each(['127.0.0.1', 'localhost', '169.254.169.254', 'forklift', ''])(
    'refuses to request %s without calling fetch',
    async host => {
      const result = await probeHost(host);

      expect(result.reachable).toBe(false);
      expect(result.error).toBe('Host is not a valid public domain name');
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});
