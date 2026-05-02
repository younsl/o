import React from 'react';
import { Tooltip, TooltipTrigger } from '@backstage/ui';
import {
  DashboardAlertRule,
  DashboardItem,
  DashboardTier,
  DASHBOARD_TIERS,
} from '../../api/types';
import { TierBadge } from './TierBadge';
import { Stars } from './Stars';
import './DashboardLeaf.css';

const MAX_RULES_IN_TOOLTIP = 12;

export const AlertSection = ({
  total,
  firing,
  rules,
}: {
  total: number;
  firing: number;
  rules: DashboardAlertRule[];
}) => {
  if (total === 0) {
    return <div className="gdm-leaf-tip-alerts-muted">No alerts attached</div>;
  }
  const visible = rules.slice(0, MAX_RULES_IN_TOOLTIP);
  const overflow = rules.length - visible.length;
  return (
    <div className="gdm-leaf-tip-alerts">
      <div className="gdm-leaf-tip-alerts-header">
        {total} alert{total > 1 ? 's' : ''}
        {firing > 0 ? ` · ${firing} firing` : ' · none firing'}
      </div>
      {visible.map((r, i) => (
        <div
          key={`${r.name}-${i}`}
          className={`gdm-leaf-tip-alert${r.firing ? ' firing' : ''}`}
        >
          <span className="gdm-leaf-tip-alert-dot" />
          <span className="gdm-leaf-tip-alert-name">{r.name}</span>
        </div>
      ))}
      {overflow > 0 && (
        <div className="gdm-leaf-tip-alerts-more">… +{overflow} more</div>
      )}
    </div>
  );
};

export function buildAlertTooltip(
  total: number,
  firing: number,
  rules: DashboardAlertRule[],
): string {
  if (total === 0) return 'No alerts attached';
  const header =
    firing > 0
      ? `${total} alert${total > 1 ? 's' : ''} (${firing} firing)`
      : `${total} alert${total > 1 ? 's' : ''} (none firing)`;
  if (rules.length === 0) return header;
  const lines = rules
    .slice(0, MAX_RULES_IN_TOOLTIP)
    .map(r => `${r.firing ? '● ' : '○ '}${r.name}`);
  if (rules.length > MAX_RULES_IN_TOOLTIP) {
    lines.push(`… +${rules.length - MAX_RULES_IN_TOOLTIP} more`);
  }
  return `${header}\n${lines.join('\n')}`;
}

export type LeafContext = 'inspector' | 'unassigned';

export interface DashboardLeafProps {
  dashboard: DashboardItem;
  editing: boolean;
  context: LeafContext;
  /** When in 'unassigned' context, this is the currently selected box id (assign target). */
  assignTargetId?: string | null;
  /** Currently active tag filter; matching tag chips render as active. */
  activeTag?: string | null;
  onSetTier?: (uid: string, tier: DashboardTier | null) => void;
  onUnassign?: (uid: string) => void;
  onAssign?: (uid: string, nodeId: string) => void;
  onOpen?: (uid: string, url: string) => void;
  onTagClick?: (tag: string) => void;
}

export const DashboardLeaf = ({
  dashboard,
  editing,
  context,
  assignTargetId,
  activeTag,
  onSetTier,
  onUnassign,
  onAssign,
  onOpen,
  onTagClick,
}: DashboardLeafProps) => {
  const [tierMenuOpen, setTierMenuOpen] = React.useState(false);
  const menuRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (!tierMenuOpen) return undefined;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setTierMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [tierMenuOpen]);

  const open = () => {
    if (onOpen) onOpen(dashboard.uid, dashboard.url);
    else window.open(dashboard.url, '_blank', 'noopener,noreferrer');
  };

  const handleClick = () => {
    if (editing && context === 'unassigned' && assignTargetId && onAssign) {
      onAssign(dashboard.uid, assignTargetId);
      return;
    }
    open();
  };

  const showMeta = !!dashboard.folder;
  const metaText = dashboard.folder ?? '';
  const tagsToShow =
    context === 'unassigned' ? dashboard.tags.slice(0, 4) : [];

  const tierClickable = editing && context === 'inspector';
  const showTooltip = context === 'inspector';

  const alertState = dashboard.alertState === 'firing' ? 'firing' : 'ok';
  const totalAlerts = dashboard.alertCount ?? 0;
  const firingAlerts = dashboard.firingCount ?? 0;
  const ledLabel = buildAlertTooltip(
    totalAlerts,
    firingAlerts,
    dashboard.alertRules ?? [],
  );

  const row = (
      <div className="gdm-leaf-row" onClick={handleClick} role="button">
        {tierClickable ? (
          <span
            ref={menuRef}
            style={{ position: 'relative' }}
            title={ledLabel}
            aria-label={ledLabel}
          >
            <button
              type="button"
              className="gdm-leaf-badge-btn"
              onClick={e => {
                e.stopPropagation();
                setTierMenuOpen(o => !o);
              }}
              aria-label="Set tier"
            >
              <TierBadge tier={dashboard.tier} alertState={alertState} />
            </button>
            {tierMenuOpen && (
              <div
                className="gdm-leaf-tier-menu"
                onClick={e => e.stopPropagation()}
              >
                <button
                  type="button"
                  className={`gdm-leaf-tier-menu-item${
                    dashboard.tier === null ? ' selected' : ''
                  }`}
                  onClick={() => {
                    setTierMenuOpen(false);
                    onSetTier?.(dashboard.uid, null);
                  }}
                >
                  None
                </button>
                {DASHBOARD_TIERS.map(t => (
                  <button
                    key={t}
                    type="button"
                    className={`gdm-leaf-tier-menu-item${
                      dashboard.tier === t ? ' selected' : ''
                    }`}
                    onClick={() => {
                      setTierMenuOpen(false);
                      onSetTier?.(dashboard.uid, t);
                    }}
                  >
                    {t}
                  </button>
                ))}
              </div>
            )}
          </span>
        ) : (
          <span title={ledLabel} aria-label={ledLabel}>
            <TierBadge tier={dashboard.tier} alertState={alertState} />
          </span>
        )}
        {totalAlerts > 0 && (
          <span className="gdm-leaf-alert-count" title={ledLabel}>
            {firingAlerts > 0 ? `${firingAlerts}/${totalAlerts}` : totalAlerts}
          </span>
        )}
        <div className="gdm-leaf-body">
          <span className="gdm-leaf-title" title={dashboard.title}>
            {dashboard.title}
          </span>
          {showMeta && (
            <span className="gdm-leaf-meta" title={metaText}>
              {metaText}
            </span>
          )}
        </div>
        {tagsToShow.length > 0 && onTagClick && (
          <span className="gdm-leaf-tags">
            {tagsToShow.map(t => (
              <button
                key={t}
                type="button"
                className={`gdm-leaf-tag${activeTag === t ? ' active' : ''}`}
                onClick={e => {
                  e.stopPropagation();
                  onTagClick(t);
                }}
              >
                {t}
              </button>
            ))}
          </span>
        )}
        {editing && context === 'inspector' && onUnassign && (
          <button
            type="button"
            className="gdm-leaf-text-btn"
            onClick={e => {
              e.stopPropagation();
              onUnassign(dashboard.uid);
            }}
          >
            Remove
          </button>
        )}
        {editing && context === 'unassigned' && assignTargetId && onAssign && (
          <button
            type="button"
            className="gdm-leaf-text-btn"
            onClick={e => {
              e.stopPropagation();
              onAssign(dashboard.uid, assignTargetId);
            }}
          >
            Add
          </button>
        )}
      </div>
  );

  if (!showTooltip) return row;

  return (
    <TooltipTrigger>
      {row}
      <Tooltip>
        <div className="gdm-leaf-tip-title">{dashboard.title}</div>
        <div className="gdm-leaf-tip-meta">
          <TierBadge tier={dashboard.tier} />
          <Stars count={dashboard.clickCount} />
        </div>
        {dashboard.tags.length > 0 ? (
          <div className="gdm-leaf-tip-tags">{dashboard.tags.join(' · ')}</div>
        ) : (
          <div className="gdm-leaf-tip-muted">No tags</div>
        )}
        <AlertSection
          total={totalAlerts}
          firing={firingAlerts}
          rules={dashboard.alertRules ?? []}
        />
      </Tooltip>
    </TooltipTrigger>
  );
};
