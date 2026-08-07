import React from 'react';

/**
 * Get UTC epoch (seconds) for midnight of dateStr (YYYY-MM-DD) in the given IANA timezone.
 * e.g. "2026-03-14" in "Asia/Seoul" → UTC 2026-03-13T15:00:00Z
 */
export function midnightEpochInTz(dateStr: string, tz: string): number {
  const probeUtc = new Date(`${dateStr}T12:00:00Z`);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(probeUtc);
  const get = (type: string) => parseInt(parts.find(p => p.type === type)?.value ?? '0', 10);

  const tzHour = get('hour') === 24 ? 0 : get('hour');
  const tzAsUtcMs = Date.UTC(get('year'), get('month') - 1, get('day'), tzHour, get('minute'), get('second'));
  const offsetMs = tzAsUtcMs - probeUtc.getTime();

  const localMidnightMs = Date.UTC(
    parseInt(dateStr.substring(0, 4), 10),
    parseInt(dateStr.substring(5, 7), 10) - 1,
    parseInt(dateStr.substring(8, 10), 10),
  );
  return Math.floor((localMidnightMs - offsetMs) / 1000);
}

/** Convert a UTC timestamp (ISO string or epoch) to a YYYY-MM-DD date in the billing timezone. */
export function toDateInTz(ts: string | number, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(ts));
}

export function getMonthWindow(year: number, month: number, tz: string) {
  const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const endDate = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`;
  return {
    start: String(midnightEpochInTz(startDate, tz)),
    end: String(midnightEpochInTz(endDate, tz)),
  };
}

export function getDayWindow(dateStr: string, tz: string) {
  const startEpoch = midnightEpochInTz(dateStr, tz);
  return {
    start: String(startEpoch),
    end: String(startEpoch + 86400),
  };
}

export function getYearWindow(year: number, tz: string) {
  const startDate = `${year}-01-01`;
  const endDate = `${year + 1}-01-01`;
  return {
    start: String(midnightEpochInTz(startDate, tz)),
    end: String(midnightEpochInTz(endDate, tz)),
  };
}

export function truncate1(n: number): number {
  return Math.floor(n * 10) / 10;
}

export function formatCost(cost: number): string {
  return `$${truncate1(cost)}`;
}

export function formatCarbon(kg: number): string {
  if (kg >= 1000) return `${truncate1(kg / 1000)} t`;
  if (kg >= 1) return `${truncate1(kg)} kg`;
  return `${truncate1(kg * 1000)} g`;
}

export function highlightMatch(text: string, query: string): React.ReactNode {
  if (!query) return text;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text;
  return React.createElement(React.Fragment, null,
    text.slice(0, idx),
    React.createElement('mark', { className: 'oc-highlight' }, text.slice(idx, idx + query.length)),
    text.slice(idx + query.length),
  );
}

export function randomHash(len = 6): string {
  const chars = 'abcdef0123456789';
  return Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

export function downloadCsv(headers: string[], rows: (string | number)[][], filename: string) {
  const escape = (v: string | number) => {
    const s = String(v);
    return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [headers.map(escape).join(','), ...rows.map(r => r.map(escape).join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function toTzString(utcIso: string, tz: string): string {
  const d = new Date(utcIso);
  const datePart = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d);
  const timePart = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d);
  return `${datePart} ${timePart} (${tz})`;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}
