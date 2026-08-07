import React from 'react';
import { Text } from '@backstage/ui';
import { DashboardItem } from '../../api/types';
import { DashboardLeaf } from './DashboardLeaf';
import './UnassignedTree.css';

interface FolderNode {
  name: string;
  path: string;
  children: Map<string, FolderNode>;
  dashboards: DashboardItem[];
}

function buildTree(dashboards: DashboardItem[]): FolderNode {
  const root: FolderNode = {
    name: '',
    path: '',
    children: new Map(),
    dashboards: [],
  };
  for (const d of dashboards) {
    const folder = (d.folder ?? '').trim();
    if (!folder) {
      root.dashboards.push(d);
      continue;
    }
    const parts = folder.split('/').map(p => p.trim()).filter(Boolean);
    let cur = root;
    let pathAcc = '';
    for (const part of parts) {
      pathAcc = pathAcc ? `${pathAcc}/${part}` : part;
      let next = cur.children.get(part);
      if (!next) {
        next = {
          name: part,
          path: pathAcc,
          children: new Map(),
          dashboards: [],
        };
        cur.children.set(part, next);
      }
      cur = next;
    }
    cur.dashboards.push(d);
  }
  const sortDeep = (n: FolderNode) => {
    n.dashboards.sort((a, b) => a.title.localeCompare(b.title));
    n.children = new Map(
      Array.from(n.children.entries()).sort(([a], [b]) => a.localeCompare(b)),
    );
    for (const c of n.children.values()) sortDeep(c);
  };
  sortDeep(root);
  return root;
}

function totalCount(n: FolderNode): number {
  let t = n.dashboards.length;
  for (const c of n.children.values()) t += totalCount(c);
  return t;
}

interface FolderItemProps {
  node: FolderNode;
  defaultOpen: boolean;
  editing: boolean;
  assignTargetId: string | null;
  activeTag: string | null;
  onAssign: (uid: string, nodeId: string) => void;
  onOpen: (uid: string, url: string) => void;
  onTagClick: (tag: string) => void;
}

const FolderItem = ({
  node,
  defaultOpen,
  editing,
  assignTargetId,
  activeTag,
  onAssign,
  onOpen,
  onTagClick,
}: FolderItemProps) => {
  const [open, setOpen] = React.useState(defaultOpen);
  React.useEffect(() => {
    setOpen(defaultOpen);
  }, [defaultOpen]);

  const total = totalCount(node);
  if (total === 0) return null;

  return (
    <div>
      <div
        className="gdm-folder-row"
        onClick={() => setOpen(o => !o)}
        role="button"
        aria-expanded={open}
      >
        <span className="gdm-folder-caret">{open ? '▾' : '▸'}</span>
        <span className="gdm-folder-name">{node.name || 'General'}</span>
        <span className="gdm-folder-count">· {total}</span>
      </div>
      {open && (
        <div className="gdm-folder-children">
          {Array.from(node.children.values()).map(child => (
            <FolderItem
              key={child.path}
              node={child}
              defaultOpen={defaultOpen}
              editing={editing}
              assignTargetId={assignTargetId}
              activeTag={activeTag}
              onAssign={onAssign}
              onOpen={onOpen}
              onTagClick={onTagClick}
            />
          ))}
          {node.dashboards.map(d => (
            <DashboardLeaf
              key={d.uid}
              dashboard={d}
              editing={editing}
              context="unassigned"
              assignTargetId={assignTargetId}
              activeTag={activeTag}
              onAssign={onAssign}
              onOpen={onOpen}
              onTagClick={onTagClick}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export interface UnassignedTreeProps {
  dashboards: DashboardItem[];
  editing: boolean;
  assignTargetId: string | null;
  searchActive: boolean;
  totalDashboards: number;
  assignedDashboards: number;
  activeTag: string | null;
  onAssign: (uid: string, nodeId: string) => void;
  onOpen: (uid: string, url: string) => void;
  onTagClick: (tag: string) => void;
}

export const UnassignedTree = ({
  dashboards,
  editing,
  assignTargetId,
  searchActive,
  totalDashboards,
  assignedDashboards,
  activeTag,
  onAssign,
  onOpen,
  onTagClick,
}: UnassignedTreeProps) => {
  const tree = React.useMemo(() => buildTree(dashboards), [dashboards]);
  const total = dashboards.length;
  const folderChildren = Array.from(tree.children.values());

  return (
    <div className="gdm-unassigned-wrapper">
      <div className="gdm-unassigned-header">
        <span className="gdm-unassigned-title">Unassigned Dashboards</span>
        <span className="gdm-unassigned-meta">
          {assignedDashboards} / {totalDashboards} assigned · {total} unassigned
        </span>
      </div>
      {editing && (
        <Text className="gdm-unassigned-hint">
          {assignTargetId
            ? 'Click a dashboard to add it to the selected box.'
            : 'Select a box on the canvas, then click a dashboard here to assign it.'}
        </Text>
      )}
      {total === 0 ? (
        <div className="gdm-unassigned-empty">No unassigned dashboards.</div>
      ) : (
        <div>
          {folderChildren.map(c => (
            <FolderItem
              key={c.path}
              node={c}
              defaultOpen={searchActive}
              editing={editing}
              assignTargetId={assignTargetId}
              activeTag={activeTag}
              onAssign={onAssign}
              onOpen={onOpen}
              onTagClick={onTagClick}
            />
          ))}
          {tree.dashboards.length > 0 && (
            <FolderItem
              node={{
                name: 'General',
                path: '__root__',
                children: new Map(),
                dashboards: tree.dashboards,
              }}
              defaultOpen={searchActive || folderChildren.length === 0}
              editing={editing}
              assignTargetId={assignTargetId}
              activeTag={activeTag}
              onAssign={onAssign}
              onOpen={onOpen}
              onTagClick={onTagClick}
            />
          )}
        </div>
      )}
    </div>
  );
};
