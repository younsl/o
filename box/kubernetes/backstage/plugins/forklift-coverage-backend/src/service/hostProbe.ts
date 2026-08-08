import fetch from 'node-fetch';
import { HostProbeResult } from './types';

const PROBE_TIMEOUT_MS = 8_000;

// Anchored with a single bounded quantifier each, so neither regex can
// backtrack polynomially on adversarial input.
const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;
const TLD_RE = /^[a-z]{2,63}$/i;
const PORT_RE = /^\d{1,5}$/;

const MAX_HOST_LENGTH = 253;
const MAX_PORT = 65535;

/**
 * A host is a bare `host` or `host:port`. Rejecting a scheme, path, userinfo,
 * or query keeps the probe from turning an admin form into a general purpose
 * request forwarder: the backend only ever calls `https://<host>/`.
 *
 * At least two labels and a letters only last label are required, which rules
 * out bare IP literals and single label names. `127.0.0.1`, `169.254.169.254`,
 * and `localhost` otherwise satisfy the host grammar while pointing at the
 * backend itself or at cloud instance metadata, so accepting them would make
 * the probe an internal reachability scanner.
 */
export function isValidProbeTarget(host: string): boolean {
  const parts = host.split(':');
  if (parts.length > 2) return false;

  const [name, port] = parts;
  if (port !== undefined && (!PORT_RE.test(port) || Number(port) > MAX_PORT)) {
    return false;
  }

  if (!name || name.length > MAX_HOST_LENGTH) return false;
  const labels = name.split('.');
  if (labels.length < 2) return false;
  if (!TLD_RE.test(labels[labels.length - 1])) return false;
  return labels.every(label => LABEL_RE.test(label));
}

export function normalizeHost(raw: string): string {
  let host = raw.trim().replace(/^https?:\/\//i, '');
  // Trailing slashes are stripped with a loop: `/\/+$/` backtracks
  // polynomially on a long run of slashes (js/polynomial-redos).
  while (host.endsWith('/')) {
    host = host.slice(0, -1);
  }
  return host;
}

export function validateHost(raw: string): string | null {
  const host = normalizeHost(raw);
  if (!host) return 'Host is required';
  if (/[/@?#\s]/.test(host)) {
    return 'Enter a bare host such as forklift.example.com, with no scheme or path';
  }
  const port = host.split(':')[1];
  if (port && PORT_RE.test(port) && Number(port) > MAX_PORT) {
    return 'Port is out of range';
  }
  if (!isValidProbeTarget(host)) {
    return 'Host must be a public domain name such as forklift.example.com, not an IP address';
  }
  return null;
}

/**
 * Confirms something answers at the host. Any HTTP status counts as reachable,
 * including 401 and 404, because an artifact repository may well refuse an
 * anonymous root request while being perfectly healthy. Only a transport level
 * failure or a timeout means unreachable.
 */
export async function probeHost(rawHost: string): Promise<HostProbeResult> {
  const host = normalizeHost(rawHost);
  const startedAt = Date.now();

  // Checked here and not only in the caller: the host arrives in a request
  // body, so the grammar check has to guard the outbound call itself rather
  // than sit in a validator a later caller could forget.
  if (!isValidProbeTarget(host)) {
    return {
      reachable: false,
      status: null,
      latencyMs: 0,
      error: 'Host is not a valid public domain name',
    };
  }

  try {
    const res = await fetch(`https://${host}/`, {
      method: 'GET',
      redirect: 'manual',
      timeout: PROBE_TIMEOUT_MS,
    } as any);
    return {
      reachable: true,
      status: res.status,
      latencyMs: Date.now() - startedAt,
      error: null,
    };
  } catch (err) {
    return {
      reachable: false,
      status: null,
      latencyMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
