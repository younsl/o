import React from 'react';
import { DashboardAlertState, DashboardTier } from '../../api/types';
import './TierBadge.css';

const LABEL: Record<DashboardTier | 'NONE', string> = {
  L1: 'L1',
  L2: 'L2',
  L3: 'L3',
  NONE: '—',
};

export const TierBadge = ({
  tier,
  alertState,
}: {
  tier: DashboardTier | null;
  alertState?: DashboardAlertState;
}) => {
  const tierClass =
    tier === 'L1'
      ? 'gdm-tier-l1'
      : tier === 'L2'
        ? 'gdm-tier-l2'
        : tier === 'L3'
          ? 'gdm-tier-l3'
          : 'gdm-tier-none';
  const stateClass = alertState
    ? alertState === 'firing'
      ? 'gdm-tier-state-firing'
      : 'gdm-tier-state-ok'
    : '';
  const label = tier ?? 'NONE';
  return (
    <span
      className={`gdm-tier-badge ${tierClass} ${stateClass}`.trim()}
      title={tier ? `Tier ${tier}` : 'No tier'}
    >
      {LABEL[label]}
    </span>
  );
};
