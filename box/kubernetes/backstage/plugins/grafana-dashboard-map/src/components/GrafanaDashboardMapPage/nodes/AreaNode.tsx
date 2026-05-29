import React from 'react';
import { NodeProps, NodeResizer } from '@xyflow/react';
import { useThemeTokens } from '../themeTokens';
import './AreaNode.css';

export interface AreaNodeData {
  label: string;
  description?: string;
  editing: boolean;
  onLabelChange: (id: string, label: string) => void;
  onDescriptionChange: (id: string, description: string) => void;
}

export const AreaNode = ({ id, data, selected }: NodeProps) => {
  const tokens = useThemeTokens();
  const d = data as unknown as AreaNodeData;
  return (
    <>
      <NodeResizer
        isVisible={d.editing && !!selected}
        minWidth={200}
        minHeight={140}
        handleStyle={{
          width: 8,
          height: 8,
          background: tokens.fgPrimary,
          borderRadius: 1,
        }}
      />
      <div className={`gdm-area-node${selected ? ' selected' : ''}`}>
        <div className="gdm-area-header">
          {d.editing ? (
            <input
              className="gdm-area-label-input nodrag nopan"
              value={d.label}
              placeholder="Area name"
              onChange={e => d.onLabelChange(id, e.target.value)}
              onKeyDown={e => e.stopPropagation()}
              onClick={e => e.stopPropagation()}
            />
          ) : (
            <span className="gdm-area-label" title={d.label}>
              {d.label || 'Area'}
            </span>
          )}
        </div>
        {d.editing ? (
          <input
            className="gdm-area-desc-input nodrag nopan"
            value={d.description ?? ''}
            placeholder="Description"
            onChange={e => d.onDescriptionChange(id, e.target.value)}
            onKeyDown={e => e.stopPropagation()}
            onClick={e => e.stopPropagation()}
          />
        ) : (
          d.description && (
            <div className="gdm-area-description" title={d.description}>
              {d.description}
            </div>
          )
        )}
      </div>
    </>
  );
};
