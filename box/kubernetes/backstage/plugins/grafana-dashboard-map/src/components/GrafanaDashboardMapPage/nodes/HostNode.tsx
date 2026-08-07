import React from 'react';
import { createPortal } from 'react-dom';
import { Handle, NodeProps, NodeResizer, Position } from '@xyflow/react';
import { RiGroupLine } from '@remixicon/react';
import {
  DashboardItem,
  DashboardTier,
  NodeType,
} from '../../../api/types';
import { TierBadge } from '../TierBadge';
import { Stars } from '../Stars';
import { AlertSection } from '../DashboardLeaf';
import { useThemeTokens } from '../themeTokens';
import './HostNode.css';

export interface HostNodeData {
  label: string;
  description?: string;
  editing: boolean;
  dashboards: DashboardItem[];
  counts: { L1: number; L2: number; L3: number; NONE: number; total: number };
  onLabelChange: (id: string, label: string) => void;
  onDescriptionChange: (id: string, description: string) => void;
  onUnassign: (uid: string) => void;
  onSetTier: (uid: string, tier: DashboardTier | null) => void;
  onOpenDashboard: (uid: string, url: string) => void;
}

interface HostNodeImplProps extends NodeProps {
  kind: Extract<NodeType, 'box' | 'group'>;
}

const HostNodeImpl = ({ id, data, selected, kind }: HostNodeImplProps) => {
  const tokens = useThemeTokens();
  const d = data as unknown as HostNodeData;
  const editing = d.editing;
  const [tierMenu, setTierMenu] = React.useState<{
    uid: string;
    x: number;
    y: number;
  } | null>(null);
  const [hover, setHover] = React.useState<{
    uid: string;
    x: number;
    y: number;
  } | null>(null);
  const tierMenuRef = React.useRef<HTMLDivElement | null>(null);
  const tierTriggerRefs = React.useRef<Map<string, HTMLButtonElement>>(
    new Map(),
  );

  React.useEffect(() => {
    if (!tierMenu) return undefined;
    const handler = (e: MouseEvent) => {
      const trigger = tierTriggerRefs.current.get(tierMenu.uid);
      if (
        tierMenuRef.current &&
        !tierMenuRef.current.contains(e.target as Node) &&
        (!trigger || !trigger.contains(e.target as Node))
      ) {
        setTierMenu(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [tierMenu]);

  const handleOpen = (uid: string, url: string) => () =>
    d.onOpenDashboard(uid, url);

  const handleClass = (visible: boolean) =>
    `gdm-host-handle${visible ? '' : ' gdm-host-handle-hidden'}`;

  return (
    <>
      <NodeResizer
        isVisible={editing && !!selected}
        minWidth={160}
        minHeight={120}
        handleStyle={{
          width: 8,
          height: 8,
          background: tokens.fgPrimary,
          borderRadius: 1,
        }}
      />
      <Handle
        id="t"
        type="source"
        position={Position.Top}
        className={handleClass(editing)}
        isConnectable={editing}
      />
      <Handle
        id="r"
        type="source"
        position={Position.Right}
        className={handleClass(editing)}
        isConnectable={editing}
      />
      <Handle
        id="b"
        type="source"
        position={Position.Bottom}
        className={handleClass(editing)}
        isConnectable={editing}
      />
      <Handle
        id="l"
        type="source"
        position={Position.Left}
        className={handleClass(editing)}
        isConnectable={editing}
      />
      <div className={`gdm-host-node${selected ? ' selected' : ''}`}>
        <div className="gdm-host-header">
          {kind === 'group' && (
            <RiGroupLine className="gdm-host-icon" size={14} />
          )}
          {editing ? (
            <input
              className="gdm-host-input-base gdm-host-label-input nodrag nopan"
              value={d.label}
              placeholder="Name"
              onChange={e => d.onLabelChange(id, e.target.value)}
              onKeyDown={e => e.stopPropagation()}
              onClick={e => e.stopPropagation()}
            />
          ) : (
            <span className="gdm-host-label" title={d.label}>
              {d.label || 'Untitled'}
            </span>
          )}
        </div>
        {editing ? (
          <textarea
            className="gdm-host-desc-input nodrag nopan"
            value={d.description ?? ''}
            placeholder="Description"
            onChange={e => d.onDescriptionChange(id, e.target.value)}
            onKeyDown={e => e.stopPropagation()}
            onClick={e => e.stopPropagation()}
          />
        ) : (
          d.description && (
            <div className="gdm-host-description" title={d.description}>
              {d.description}
            </div>
          )
        )}
        <div className="gdm-host-body">
          {d.dashboards.length === 0 ? (
            <div className="gdm-host-empty-body">
              {editing ? 'Add from the unassigned list below' : 'No dashboards'}
            </div>
          ) : (
            d.dashboards.map(item => (
              <div
                key={item.uid}
                className="gdm-host-row-wrap"
                onMouseEnter={e => {
                  const rect = (
                    e.currentTarget as HTMLElement
                  ).getBoundingClientRect();
                  setHover({
                    uid: item.uid,
                    x: rect.left + rect.width / 2,
                    y: rect.top - 6,
                  });
                }}
                onMouseLeave={() =>
                  setHover(h => (h?.uid === item.uid ? null : h))
                }
              >
                <div
                  className="gdm-host-dash-row"
                  onClick={
                    editing ? undefined : handleOpen(item.uid, item.url)
                  }
                >
                  {editing ? (
                    <button
                      type="button"
                      ref={el => {
                        if (el) tierTriggerRefs.current.set(item.uid, el);
                        else tierTriggerRefs.current.delete(item.uid);
                      }}
                      className="gdm-host-tier-trigger nodrag nopan"
                      onClick={e => {
                        e.stopPropagation();
                        const rect = (
                          e.currentTarget as HTMLElement
                        ).getBoundingClientRect();
                        const next = {
                          uid: item.uid,
                          x: rect.left,
                          y: rect.bottom + 4,
                        };
                        setTierMenu(prev =>
                          prev?.uid === item.uid ? null : next,
                        );
                      }}
                      aria-label="Set tier"
                    >
                      <TierBadge
                        tier={item.tier}
                        alertState={item.alertState === 'firing' ? 'firing' : 'ok'}
                      />
                    </button>
                  ) : (
                    <TierBadge
                      tier={item.tier}
                      alertState={item.alertState === 'firing' ? 'firing' : 'ok'}
                    />
                  )}
                  {(item.alertCount ?? 0) > 0 && (
                    <span className="gdm-host-alert-count">
                      {(item.firingCount ?? 0) > 0
                        ? `${item.firingCount}/${item.alertCount}`
                        : item.alertCount}
                    </span>
                  )}
                  <span className="gdm-host-dash-title">{item.title}</span>
                  {editing && (
                    <button
                      type="button"
                      className="gdm-host-remove-btn nodrag nopan"
                      onClick={e => {
                        e.stopPropagation();
                        d.onUnassign(item.uid);
                      }}
                      aria-label="Remove"
                    >
                      ×
                    </button>
                  )}
                </div>
                {hover?.uid === item.uid &&
                  createPortal(
                    <div
                      className="gdm-host-tooltip"
                      style={{ left: hover.x, top: hover.y }}
                    >
                      <div className="gdm-host-tip-title">{item.title}</div>
                      <div className="gdm-host-tip-meta">
                        <TierBadge tier={item.tier} />
                        <Stars count={item.clickCount} />
                      </div>
                      {item.tags.length > 0 ? (
                        <div className="gdm-host-tip-tags">
                          {item.tags.join(' · ')}
                        </div>
                      ) : (
                        <div className="gdm-host-tip-muted">No tags</div>
                      )}
                      <AlertSection
                        total={item.alertCount ?? 0}
                        firing={item.firingCount ?? 0}
                        rules={item.alertRules ?? []}
                      />
                    </div>,
                    document.body,
                  )}
              </div>
            ))
          )}
        </div>
        <div className="gdm-host-footer">
          <span className="gdm-host-total-label">Dashboards</span>
          <span className="gdm-host-total">{d.counts.total}</span>
        </div>
      </div>
      {tierMenu &&
        (() => {
          const target = d.dashboards.find(x => x.uid === tierMenu.uid);
          if (!target) return null;
          return createPortal(
            <div
              ref={tierMenuRef}
              className="gdm-host-tier-menu"
              style={{ left: tierMenu.x, top: tierMenu.y }}
              onClick={e => e.stopPropagation()}
            >
              <button
                type="button"
                className={`gdm-host-tier-menu-item${
                  target.tier === null ? ' selected' : ''
                }`}
                onClick={() => {
                  setTierMenu(null);
                  d.onSetTier(target.uid, null);
                }}
              >
                None
              </button>
              {(['L1', 'L2', 'L3'] as DashboardTier[]).map(t => (
                <button
                  key={t}
                  type="button"
                  className={`gdm-host-tier-menu-item${
                    target.tier === t ? ' selected' : ''
                  }`}
                  onClick={() => {
                    setTierMenu(null);
                    d.onSetTier(target.uid, t);
                  }}
                >
                  {t}
                </button>
              ))}
            </div>,
            document.body,
          );
        })()}
    </>
  );
};

export const BoxNode = (props: NodeProps) => (
  <HostNodeImpl {...props} kind="box" />
);
export const GroupNode = (props: NodeProps) => (
  <HostNodeImpl {...props} kind="group" />
);
