import React from 'react';
import { Tag, TagGroup } from '@backstage/ui';
import { RequestStatus, ScalingRequest } from '../api/types';
import './opensearch-scaling.css';

export const STATUS_LABEL: Record<RequestStatus, string> = {
  scheduled: 'Scheduled',
  validating: 'Validating',
  in_progress: 'In progress',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export const toKey = (key: unknown): string =>
  key == null ? '' : String(key);

/** "user:default/jane.doe" -> "jane.doe" for friendlier display. */
export const displayUser = (ref: string): string =>
  ref.includes('/') ? ref.split('/').pop() || ref : ref;

/**
 * Compact "time remaining" like "1d1h2m". Returns "due" when the instant has
 * passed. Omits leading zero units (e.g. "1h2m", "2m").
 */
export const formatCountdown = (ms: number): string => {
  if (ms <= 0) return 'due';
  const totalMin = Math.floor(ms / 60000);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  let out = '';
  if (d > 0) out += `${d}d`;
  if (d > 0 || h > 0) out += `${h}h`;
  out += `${m}m`;
  return out;
};

export const StatusBadge = ({ status }: { status: RequestStatus }) => (
  <span className={`osc-status osc-status-${status}`}>
    {STATUS_LABEL[status]}
  </span>
);

/** Compact "type / count / GB" summary shown in the reservation list. */
export const ChangeSummary = ({ req }: { req: ScalingRequest }) => (
  <TagGroup>
    <Tag id="type" size="small">
      {req.instanceType}
    </Tag>
    <Tag id="count" size="small">
      {req.instanceCount} nodes
    </Tag>
    <Tag id="ebs" size="small">
      {req.volumeSizeGb} GB
    </Tag>
  </TagGroup>
);
