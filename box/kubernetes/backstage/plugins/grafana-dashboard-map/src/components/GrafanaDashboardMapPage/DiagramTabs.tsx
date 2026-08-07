import React from 'react';
import { Diagram } from '../../api/types';
import './DiagramTabs.css';

export interface DiagramTabsProps {
  diagrams: Diagram[];
  activeId: string | null;
  isAdmin: boolean;
  isEditing: boolean;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onRename: (diagram: Diagram, nextName: string) => void;
  onDelete: (diagram: Diagram) => void;
}

export const DiagramTabs: React.FC<DiagramTabsProps> = ({
  diagrams,
  activeId,
  isAdmin,
  isEditing,
  onSelect,
  onCreate,
  onRename,
  onDelete,
}) => {
  const canDelete = diagrams.length > 1;
  const [renamingId, setRenamingId] = React.useState<string | null>(null);
  const [draftName, setDraftName] = React.useState('');
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    if (renamingId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [renamingId]);

  // Cancel rename if the diagram disappears, becomes inactive, or edit mode starts.
  React.useEffect(() => {
    if (!renamingId) return;
    if (isEditing) {
      setRenamingId(null);
      return;
    }
    if (renamingId !== activeId) {
      setRenamingId(null);
      return;
    }
    if (!diagrams.some(d => d.id === renamingId)) {
      setRenamingId(null);
    }
  }, [renamingId, activeId, isEditing, diagrams]);

  const startRename = (d: Diagram) => {
    setRenamingId(d.id);
    setDraftName(d.name);
  };

  const cancelRename = () => {
    setRenamingId(null);
    setDraftName('');
  };

  const commitRename = (d: Diagram) => {
    const next = draftName.trim();
    setRenamingId(null);
    setDraftName('');
    if (!next || next === d.name) return;
    onRename(d, next);
  };

  return (
    <div className="gdm-diagram-tabs" role="tablist" aria-label="Diagrams">
      {diagrams.map(d => {
        const active = d.id === activeId;
        const renaming = renamingId === d.id;
        return (
          <div
            key={d.id}
            className={`gdm-diagram-tab${active ? ' gdm-diagram-tab--active' : ''}`}
          >
            {renaming ? (
              <input
                ref={inputRef}
                className="gdm-diagram-tab__input"
                value={draftName}
                onChange={e => setDraftName(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    commitRename(d);
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    cancelRename();
                  }
                }}
                onBlur={() => commitRename(d)}
                maxLength={200}
                aria-label={`Rename ${d.name}`}
              />
            ) : (
              <button
                type="button"
                role="tab"
                aria-selected={active}
                className="gdm-diagram-tab__label"
                onClick={() => onSelect(d.id)}
                onDoubleClick={() => {
                  if (isAdmin && active && !isEditing) startRename(d);
                }}
                title={
                  isAdmin && active && !isEditing
                    ? 'Double-click to rename'
                    : d.description || d.name
                }
                disabled={isEditing && !active}
              >
                {d.name}
              </button>
            )}
            {isAdmin && active && !isEditing && !renaming && (
              <span className="gdm-diagram-tab__actions">
                <button
                  type="button"
                  className="gdm-diagram-tab__icon"
                  onClick={() => startRename(d)}
                  title="Rename diagram"
                  aria-label={`Rename ${d.name}`}
                >
                  ✎
                </button>
                {canDelete && (
                  <button
                    type="button"
                    className="gdm-diagram-tab__icon gdm-diagram-tab__icon--danger"
                    onClick={() => onDelete(d)}
                    title="Delete diagram"
                    aria-label={`Delete ${d.name}`}
                  >
                    ×
                  </button>
                )}
              </span>
            )}
          </div>
        );
      })}
      {isAdmin && !isEditing && (
        <button
          type="button"
          className="gdm-diagram-tab__add"
          onClick={onCreate}
          title="Create a new diagram"
        >
          + New tab
        </button>
      )}
    </div>
  );
};
