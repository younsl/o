/**
 * Visits are bucketed by calendar day rather than by rolling 24h windows, so
 * "daily visitors" matches what a person sees on a wall calendar. The bucket is
 * computed once at write time and stored, which keeps the aggregation queries as
 * plain string comparisons and therefore identical on sqlite and postgres.
 */

/** Formats an instant as a YYYY-MM-DD key in the given IANA timezone. */
export function toDayKey(date: Date, timezone: string): string {
  // en-CA renders as YYYY-MM-DD, which sorts lexicographically as a date.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/**
 * Shifts a day key by whole days. Anchoring at noon UTC keeps the arithmetic
 * clear of the ±14h the offset can move a midnight timestamp.
 */
export function shiftDayKey(dayKey: string, days: number): string {
  const anchor = new Date(`${dayKey}T12:00:00Z`);
  anchor.setUTCDate(anchor.getUTCDate() + days);
  return anchor.toISOString().slice(0, 10);
}

/** Returns `count` day keys ending at (and including) `dayKey`, oldest first. */
export function dayKeyRange(dayKey: string, count: number): string[] {
  const keys: string[] = [];
  for (let offset = count - 1; offset >= 0; offset--) {
    keys.push(shiftDayKey(dayKey, -offset));
  }
  return keys;
}
