import { RunState } from '../api/types';

/**
 * Weekday first, since a cron like '0 10 * * 1-5' is easiest to sanity check
 * against the day it lands on. Forced to en-US so the format stays stable
 * regardless of the browser locale.
 *
 * `timeZone` matters for more than the clock: a fire time is stored as an
 * instant, so rendering it in the reader's zone can name a different weekday
 * than the cron was written against. 22:00 Monday in Seoul is Monday
 * afternoon in London and Monday morning in New York, but 07:00 Monday in
 * Seoul is still Sunday in both. Pass the schedule's zone whenever the label
 * claims to be showing that zone.
 */
export const formatRunTime = (iso: string, timeZone?: string): string => {
  try {
    return new Date(iso).toLocaleString('en-US', {
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      ...(timeZone ? { timeZone } : {}),
    });
  } catch {
    // A zone the browser does not know would otherwise take the whole form
    // down, so the reader's own zone stands in.
    return new Date(iso).toLocaleString('en-US', {
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  }
};

/** `in 3h 20m`, or `overdue` once the time has passed. */
export const formatUntil = (iso: string | null): string => {
  if (!iso) return 'paused';
  const minutes = Math.round((new Date(iso).getTime() - Date.now()) / 60_000);
  if (!Number.isFinite(minutes)) return 'unknown';
  if (minutes < 0) return 'due now';
  if (minutes < 1) return 'in under a minute';
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `in ${days}d ${hours % 24}h`;
};

/** Manual runs carry a user ref, the automatic ones a fixed word. */
export const formatActor = (triggeredBy: string): string => {
  if (triggeredBy === 'schedule') return 'schedule';
  if (triggeredBy === 'manual') return 'manual';
  return triggeredBy.split('/').pop() ?? triggeredBy;
};

export const RUN_STATE_LABELS: Record<RunState, string> = {
  running: 'Running',
  success: 'Success',
  failed: 'Failed',
};
