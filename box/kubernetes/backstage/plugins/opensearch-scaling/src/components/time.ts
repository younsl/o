/**
 * Timezone helpers for flexible reservation times. The user picks a wall-clock
 * datetime (e.g. "2026-07-01T03:00") together with an IANA timezone; we convert
 * that to an absolute UTC instant for storage, and format instants back into a
 * chosen timezone for display. No external dependency: uses Intl only.
 */

/** Offset (ms) of `timeZone` at the given instant, where local = utc + offset. */
function offsetMsAt(date: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(date);
  const map: Record<string, number> = {};
  for (const p of parts) {
    if (p.type !== 'literal') map[p.type] = Number(p.value);
  }
  // `hour` can come back as 24 at midnight in some engines; normalize.
  const hour = map.hour === 24 ? 0 : map.hour;
  const asUtc = Date.UTC(
    map.year,
    map.month - 1,
    map.day,
    hour,
    map.minute,
    map.second,
  );
  return asUtc - date.getTime();
}

/**
 * Convert a wall-clock `datetime-local` string interpreted in `timeZone` to an
 * absolute UTC instant. Returns null if the input is not a valid datetime.
 */
export function zonedWallClockToUtc(
  localStr: string,
  timeZone: string,
): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(localStr);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number);
  const wallAsUtcMs = Date.UTC(y, mo - 1, d, h, mi);
  const offset = offsetMsAt(new Date(wallAsUtcMs), timeZone);
  return new Date(wallAsUtcMs - offset);
}

/** Format a UTC ISO instant in the given timezone, e.g. "2026-07-01 03:00 (Asia/Seoul)". */
export function formatInZone(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const formatted = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
    .format(date)
    .replace(',', '');
  return `${formatted} (${timeZone})`;
}
