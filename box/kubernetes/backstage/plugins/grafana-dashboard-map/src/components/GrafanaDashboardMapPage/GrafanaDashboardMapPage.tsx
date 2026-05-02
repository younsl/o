import React from 'react';
import { useApi } from '@backstage/core-plugin-api';
import {
  Progress,
  ResponseErrorPanel,
  SupportButton,
} from '@backstage/core-components';
import { Alert, Container, Flex, PluginHeader, Text } from '@backstage/ui';
import { useAsyncRetry } from 'react-use';
import {
  Architecture,
  DashboardAssignment,
  DashboardItem,
  DashboardTier,
  Diagram,
} from '../../api/types';
import './GrafanaDashboardMapPage.css';
import { grafanaDashboardMapApiRef } from '../../api';
import { ArchitectureCanvas, ArchitectureCanvasHandle } from './ArchitectureCanvas';
import { UnassignedTree } from './UnassignedTree';
import { FilterBar } from './FilterBar';
import { Toolbar } from './Toolbar';
import { DiagramTabs } from './DiagramTabs';
import { ConfirmDialog } from './ConfirmDialog';

function formatRelative(iso: string): string {
  const now = Date.now();
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const diffSec = Math.round((t - now) / 1000);
  const abs = Math.abs(diffSec);
  try {
    const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
    if (abs < 60) return rtf.format(diffSec, 'second');
    if (abs < 3600) return rtf.format(Math.round(diffSec / 60), 'minute');
    if (abs < 86400) return rtf.format(Math.round(diffSec / 3600), 'hour');
    if (abs < 30 * 86400) return rtf.format(Math.round(diffSec / 86400), 'day');
  } catch {
    /* fall through */
  }
  return new Date(iso).toLocaleDateString();
}

interface AssignmentDraft {
  byUid: Map<
    string,
    { nodeId: string | null; position: number; tier: DashboardTier | null }
  >;
}

function snapshotAssignments(dashboards: DashboardItem[]): AssignmentDraft {
  const byUid = new Map<
    string,
    { nodeId: string | null; position: number; tier: DashboardTier | null }
  >();
  for (const d of dashboards) {
    byUid.set(d.uid, { nodeId: d.nodeId, position: d.position, tier: d.tier });
  }
  return { byUid };
}

function applyAssignmentDraft(
  dashboards: DashboardItem[],
  draft: AssignmentDraft,
): DashboardItem[] {
  return dashboards.map(d => {
    const o = draft.byUid.get(d.uid);
    if (!o) return d;
    return { ...d, nodeId: o.nodeId, position: o.position, tier: o.tier };
  });
}

function assignmentsDirty(a: AssignmentDraft, b: AssignmentDraft) {
  if (a.byUid.size !== b.byUid.size) return true;
  for (const [uid, av] of a.byUid) {
    const bv = b.byUid.get(uid);
    if (!bv) return true;
    if (av.nodeId !== bv.nodeId) return true;
    if (av.position !== bv.position) return true;
    if (av.tier !== bv.tier) return true;
  }
  return false;
}

function archDirty(a: Architecture, b: Architecture) {
  return JSON.stringify(a) !== JSON.stringify(b);
}

function formatActor(ref: string): string {
  const idx = ref.indexOf('/');
  return idx >= 0 ? ref.slice(idx + 1) : ref;
}

function matchesQuery(d: DashboardItem, q: string) {
  if (!q) return true;
  const n = q.toLowerCase();
  if (d.title.toLowerCase().includes(n)) return true;
  if (d.folder && d.folder.toLowerCase().includes(n)) return true;
  if (d.tags.some(t => t.toLowerCase().includes(n))) return true;
  return false;
}

function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

export const GrafanaDashboardMapPage = () => {
  const api = useApi(grafanaDashboardMapApiRef);

  const adminResult = useAsyncRetry(() => api.getAdminStatus(), [api]);
  const diagramsResult = useAsyncRetry(() => api.listDiagrams(), [api]);

  const isAdmin = adminResult.value?.isAdmin ?? false;
  const diagrams: Diagram[] = React.useMemo(
    () => diagramsResult.value ?? [],
    [diagramsResult.value],
  );

  const [activeId, setActiveId] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (diagrams.length === 0) {
      setActiveId(null);
      return;
    }
    if (!activeId || !diagrams.some(d => d.id === activeId)) {
      setActiveId(diagrams[0].id);
    }
  }, [diagrams, activeId]);

  const dashboardsResult = useAsyncRetry(
    () =>
      activeId
        ? api.getDashboards(activeId)
        : Promise.resolve({ dashboards: [], tiers: [] as DashboardTier[] }),
    [api, activeId],
  );
  const archResult = useAsyncRetry(
    () =>
      activeId
        ? api.getArchitecture(activeId)
        : Promise.resolve({ nodes: [], edges: [] } as Architecture),
    [api, activeId],
  );

  const baseDashboards = dashboardsResult.value?.dashboards ?? [];
  const baseArch = archResult.value ?? { nodes: [], edges: [] };

  const [editing, setEditing] = React.useState(false);
  const [arch, setArch] = React.useState<Architecture>(baseArch);
  const [archOriginal, setArchOriginal] = React.useState<Architecture>(baseArch);
  const [assignDraft, setAssignDraft] = React.useState<AssignmentDraft | null>(null);
  const [assignOriginal, setAssignOriginal] = React.useState<AssignmentDraft | null>(null);
  const [selectedNodeId, setSelectedNodeId] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [search, setSearch] = React.useState('');
  const [tagFilter, setTagFilter] = React.useState<string | null>(null);
  const [toast, setToast] = React.useState<{ severity: 'success' | 'error'; message: string } | null>(null);
  const [pendingDelete, setPendingDelete] = React.useState<Diagram | null>(null);
  const [deleting, setDeleting] = React.useState(false);

  const canvasHandle = React.useRef<ArchitectureCanvasHandle | null>(null);

  React.useEffect(() => {
    if (archResult.value) {
      setArch(archResult.value);
      setArchOriginal(archResult.value);
    }
  }, [archResult.value]);

  // Reset transient UI state when switching diagrams.
  React.useEffect(() => {
    setEditing(false);
    setAssignDraft(null);
    setAssignOriginal(null);
    setSelectedNodeId(null);
  }, [activeId]);

  React.useEffect(() => {
    if (!toast) return undefined;
    const id = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(id);
  }, [toast]);

  const effectiveDashboards = React.useMemo(() => {
    if (editing && assignDraft) return applyAssignmentDraft(baseDashboards, assignDraft);
    return baseDashboards;
  }, [editing, assignDraft, baseDashboards]);

  const visibleDashboards = React.useMemo(
    () =>
      effectiveDashboards.filter(
        d =>
          matchesQuery(d, search) &&
          (tagFilter === null || d.tags.includes(tagFilter)),
      ),
    [effectiveDashboards, search, tagFilter],
  );

  const handleTagClick = React.useCallback((tag: string) => {
    setTagFilter(prev => (prev === tag ? null : tag));
  }, []);

  const unassigned = visibleDashboards.filter(d => d.nodeId === null);
  const totalDashboards = effectiveDashboards.length;
  const assignedDashboards = effectiveDashboards.filter(
    d => d.nodeId !== null,
  ).length;

  const selectedNode = React.useMemo(
    () => arch.nodes.find(n => n.id === selectedNodeId) ?? null,
    [arch.nodes, selectedNodeId],
  );

  const handleEnterEdit = () => {
    setArchOriginal(baseArch);
    setArch(baseArch);
    const snap = snapshotAssignments(baseDashboards);
    setAssignOriginal(snap);
    setAssignDraft(snapshotAssignments(baseDashboards));
    setEditing(true);
  };

  const handleCancel = () => {
    setEditing(false);
    setArch(archOriginal);
    setAssignDraft(null);
    setAssignOriginal(null);
  };

  const handleArchChange = React.useCallback((next: Architecture) => {
    setArch(next);
  }, []);

  const handleSetTier = React.useCallback(
    (uid: string, tier: DashboardTier | null) => {
      setAssignDraft(prev => {
        const base = prev ?? snapshotAssignments(baseDashboards);
        const next = new Map(base.byUid);
        const cur = next.get(uid);
        if (!cur) return prev;
        next.set(uid, { ...cur, tier });
        return { byUid: next };
      });
    },
    [baseDashboards],
  );

  const handleAssign = React.useCallback(
    (uid: string, nodeId: string) => {
      setAssignDraft(prev => {
        const base = prev ?? snapshotAssignments(baseDashboards);
        const next = new Map(base.byUid);
        const cur = next.get(uid);
        if (!cur) return prev;
        let maxPos = -1;
        for (const v of next.values()) {
          if (v.nodeId === nodeId && v.position > maxPos) maxPos = v.position;
        }
        next.set(uid, { ...cur, nodeId, position: maxPos + 1 });
        return { byUid: next };
      });
    },
    [baseDashboards],
  );

  const handleOpenDashboard = React.useCallback(
    (uid: string, url: string) => {
      window.open(url, '_blank', 'noopener,noreferrer');
      api.recordClick(uid).catch(() => undefined);
    },
    [api],
  );

  const handleUnassign = React.useCallback(
    (uid: string) => {
      setAssignDraft(prev => {
        const base = prev ?? snapshotAssignments(baseDashboards);
        const next = new Map(base.byUid);
        const cur = next.get(uid);
        if (!cur) return prev;
        next.set(uid, { ...cur, nodeId: null, position: 0 });
        return { byUid: next };
      });
    },
    [baseDashboards],
  );

  const handleSave = async () => {
    if (!activeId) return;
    setSaving(true);
    try {
      const finalArch = canvasHandle.current?.toArchitecture() ?? arch;
      for (const n of finalArch.nodes) {
        if (!n.label || !n.label.trim()) {
          throw new Error('Every node must have a name.');
        }
      }
      await api.saveArchitecture(activeId, finalArch);
      const validIds = new Set(finalArch.nodes.map(n => n.id));
      const hostIds = new Set(
        finalArch.nodes
          .filter(n => n.type === 'box' || n.type === 'group')
          .map(n => n.id),
      );
      const assignments: DashboardAssignment[] = [];
      if (assignDraft) {
        for (const [uid, v] of assignDraft.byUid) {
          if (v.nodeId && validIds.has(v.nodeId) && hostIds.has(v.nodeId)) {
            assignments.push({
              dashboardUid: uid,
              nodeId: v.nodeId,
              position: v.position,
              tier: v.tier,
            });
          }
        }
        await api.saveAssignments(activeId, assignments);
      }
      setToast({ severity: 'success', message: 'Saved.' });
      setEditing(false);
      setAssignDraft(null);
      setAssignOriginal(null);
      archResult.retry();
      dashboardsResult.retry();
    } catch (error) {
      setToast({
        severity: 'error',
        message: error instanceof Error ? error.message : 'Failed to save.',
      });
    } finally {
      setSaving(false);
    }
  };

  const handleCreateDiagram = async () => {
    const takenNames = new Set(diagrams.map(d => d.name));
    let counter = diagrams.length + 1;
    let name = `Diagram ${counter}`;
    while (takenNames.has(name)) {
      counter += 1;
      name = `Diagram ${counter}`;
    }
    const baseId = slugify(name) || `diagram-${Date.now().toString(36)}`;
    const takenIds = new Set(diagrams.map(d => d.id));
    let id = baseId;
    let suffix = 1;
    while (takenIds.has(id)) {
      id = `${baseId}-${suffix++}`;
    }
    try {
      const created = await api.createDiagram({ id, name });
      diagramsResult.retry();
      setActiveId(created.id);
      setToast({ severity: 'success', message: `Created "${created.name}".` });
    } catch (error) {
      setToast({
        severity: 'error',
        message: error instanceof Error ? error.message : 'Failed to create diagram.',
      });
    }
  };

  const handleRenameDiagram = async (diagram: Diagram, nextName: string) => {
    try {
      await api.updateDiagram(diagram.id, { name: nextName });
      diagramsResult.retry();
      setToast({ severity: 'success', message: 'Renamed.' });
    } catch (error) {
      setToast({
        severity: 'error',
        message: error instanceof Error ? error.message : 'Failed to rename.',
      });
    }
  };

  const handleDeleteDiagram = (diagram: Diagram) => {
    if (diagrams.length <= 1) {
      setToast({ severity: 'error', message: 'Cannot delete the last diagram.' });
      return;
    }
    setPendingDelete(diagram);
  };

  const confirmDeleteDiagram = async () => {
    if (!pendingDelete) return;
    const target = pendingDelete;
    setDeleting(true);
    try {
      await api.deleteDiagram(target.id);
      const remaining = diagrams.filter(d => d.id !== target.id);
      diagramsResult.retry();
      if (activeId === target.id && remaining.length > 0) {
        setActiveId(remaining[0].id);
      }
      setPendingDelete(null);
      setToast({ severity: 'success', message: 'Deleted.' });
    } catch (error) {
      setToast({
        severity: 'error',
        message: error instanceof Error ? error.message : 'Failed to delete.',
      });
    } finally {
      setDeleting(false);
    }
  };

  const dirty =
    editing &&
    (archDirty(arch, archOriginal) ||
      (assignDraft && assignOriginal && assignmentsDirty(assignDraft, assignOriginal)));

  const selectedHostsDashboards =
    selectedNode?.type === 'box' || selectedNode?.type === 'group';
  const assignTargetId = editing && selectedHostsDashboards ? selectedNode!.id : null;

  let body: React.ReactNode;
  if (diagramsResult.loading && !diagramsResult.value) {
    body = <Progress />;
  } else if (diagramsResult.error) {
    body = <ResponseErrorPanel error={diagramsResult.error} />;
  } else if (!activeId) {
    body = (
      <Text variant="body-medium" color="secondary">
        No diagrams yet.
      </Text>
    );
  } else if ((dashboardsResult.loading || archResult.loading) && !dashboardsResult.value) {
    body = <Progress />;
  } else if (dashboardsResult.error) {
    body = <ResponseErrorPanel error={dashboardsResult.error} />;
  } else if (archResult.error) {
    body = <ResponseErrorPanel error={archResult.error} />;
  } else {
    body = (
      <>
        <FilterBar search={search} onSearchChange={setSearch} />
        <p className="gdm-page-hint">
          Click a dashboard to open it in a new tab.
          {editing
            ? ' Edit names and descriptions inline. Drag to move, drag handles to resize, drag from a node\'s edge to draw an arrow.'
            : ''}
        </p>
        <div className="gdm-canvas-shell">
          <ArchitectureCanvas
            architecture={arch}
            dashboards={effectiveDashboards}
            editing={editing}
            onSelectNode={setSelectedNodeId}
            onChange={handleArchChange}
            onUnassign={handleUnassign}
            onSetTier={handleSetTier}
            onOpenDashboard={handleOpenDashboard}
            innerRef={canvasHandle}
          />
        </div>
        <UnassignedTree
          dashboards={unassigned}
          editing={editing}
          assignTargetId={assignTargetId}
          searchActive={!!search || !!tagFilter}
          totalDashboards={totalDashboards}
          assignedDashboards={assignedDashboards}
          activeTag={tagFilter}
          onAssign={handleAssign}
          onOpen={handleOpenDashboard}
          onTagClick={handleTagClick}
        />
      </>
    );
  }

  return (
    <>
      <PluginHeader title="Grafana Dashboard Map" />
      <Container>
        <Flex direction="column" gap="3" p="3">
          <Flex justify="between" align="center" gap="2">
            <Text variant="body-medium" color="secondary">
              Draw your system architecture and map Grafana dashboards onto it.
            </Text>
            <Flex align="center" gap="2">
              {archResult.value?.lastSavedAt && (
                <Text
                  variant="body-x-small"
                  color="secondary"
                  title={new Date(archResult.value.lastSavedAt).toLocaleString()}
                >
                  Last saved {formatRelative(archResult.value.lastSavedAt)}
                  {archResult.value.lastSavedBy
                    ? ` by ${formatActor(archResult.value.lastSavedBy)}`
                    : ''}
                </Text>
              )}
              <Toolbar
                isAdmin={isAdmin}
                editing={editing}
                saving={saving}
                dirty={!!dirty}
                hasSelection={!!selectedNodeId}
                onEnterEdit={handleEnterEdit}
                onSave={handleSave}
                onCancel={handleCancel}
                onAddBox={() => canvasHandle.current?.addBox()}
                onAddGroup={() => canvasHandle.current?.addGroup()}
                onAddArea={() => canvasHandle.current?.addArea()}
                onDeleteSelected={() => canvasHandle.current?.deleteSelected()}
              />
              <SupportButton>
                Each tab is an independent diagram. Only admins can create,
                rename, or delete tabs and edit the architecture and dashboard
                mapping. Boxes are system components; groups are user/team
                groups; areas are visual zones. Boxes and groups host
                dashboards; areas don't.
              </SupportButton>
            </Flex>
          </Flex>
          {diagrams.length > 0 && (
            <DiagramTabs
              diagrams={diagrams}
              activeId={activeId}
              isAdmin={isAdmin}
              isEditing={editing}
              onSelect={setActiveId}
              onCreate={handleCreateDiagram}
              onRename={handleRenameDiagram}
              onDelete={handleDeleteDiagram}
            />
          )}
          {body}
          {toast && (
            <div className="gdm-toast-host">
              <Alert
                status={toast.severity === 'error' ? 'danger' : 'success'}
                title={toast.message}
              />
            </div>
          )}
        </Flex>
      </Container>
      <ConfirmDialog
        open={!!pendingDelete}
        title="Delete diagram"
        message={
          pendingDelete ? (
            <>
              Delete <strong>{pendingDelete.name}</strong> and all its nodes,
              edges, and dashboard mappings? This cannot be undone.
            </>
          ) : null
        }
        confirmLabel="Delete"
        cancelLabel="Cancel"
        destructive
        busy={deleting}
        onConfirm={confirmDeleteDiagram}
        onCancel={() => {
          if (!deleting) setPendingDelete(null);
        }}
      />
    </>
  );
};
