import React from 'react';
import {
  Background,
  BackgroundVariant,
  Connection,
  ConnectionMode,
  Controls,
  ControlButton,
  Edge,
  MiniMap,
  Node,
  NodeChange,
  EdgeChange,
  ReactFlow,
  ReactFlowProvider,
  applyEdgeChanges,
  applyNodeChanges,
  addEdge,
  getNodesBounds,
  getViewportForBounds,
  useReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { toPng } from 'html-to-image';
import { RiCameraLine } from '@remixicon/react';
import {
  Architecture,
  ArchitectureEdge,
  ArchitectureNode,
  DashboardItem,
  DashboardTier,
  NodeType,
} from '../../api/types';
import { BoxNode, GroupNode } from './nodes/HostNode';
import { AreaNode } from './nodes/AreaNode';
import { useThemeTokens } from './themeTokens';
import './ArchitectureCanvas.css';

const NODE_TYPES = {
  box: BoxNode,
  group: GroupNode,
  area: AreaNode,
};

const GRID = 16;
const snap = (n: number) => Math.round(n / GRID) * GRID;

const EMPTY_COUNTS = { L1: 0, L2: 0, L3: 0, NONE: 0, total: 0 };
const HOST_TYPES: NodeType[] = ['box', 'group'];

function tierCounts(uid: string, dashboards: DashboardItem[]) {
  const c = { L1: 0, L2: 0, L3: 0, NONE: 0, total: 0 };
  for (const d of dashboards) {
    if (d.nodeId !== uid) continue;
    c.total++;
    const k = (d.tier ?? 'NONE') as DashboardTier | 'NONE';
    c[k]++;
  }
  return c;
}

function dashboardsFor(uid: string, dashboards: DashboardItem[]) {
  return dashboards
    .filter(d => d.nodeId === uid)
    .sort((a, b) => {
      const tierOrder: Record<string, number> = { L1: 0, L2: 1, L3: 2, NONE: 3 };
      const ta = tierOrder[a.tier ?? 'NONE'];
      const tb = tierOrder[b.tier ?? 'NONE'];
      if (ta !== tb) return ta - tb;
      if (a.position !== b.position) return a.position - b.position;
      return a.title.localeCompare(b.title);
    });
}

function sortNodes(ns: Node[]): Node[] {
  return ns.slice().sort((a, b) => {
    if (a.type === 'area' && b.type !== 'area') return -1;
    if (b.type === 'area' && a.type !== 'area') return 1;
    return 0;
  });
}

function archToFlow(
  arch: Architecture,
  editing: boolean,
  edgeStroke: string,
): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = arch.nodes
    .slice()
    .sort((a, b) => {
      // Areas first so hosts render on top.
      if (a.type === 'area' && b.type !== 'area') return -1;
      if (b.type === 'area' && a.type !== 'area') return 1;
      return a.zOrder - b.zOrder;
    })
    .map(n => ({
      id: n.id,
      type: n.type,
      position: { x: n.x, y: n.y },
      width: n.width,
      height: n.height,
      data: {
        label: n.label,
        description: n.description,
        editing,
        // Host data fields are populated by a follow-up effect that has access
        // to dashboards and the latest callbacks.
        dashboards: HOST_TYPES.includes(n.type) ? [] : undefined,
        counts: HOST_TYPES.includes(n.type) ? EMPTY_COUNTS : undefined,
      },
      parentId: n.parentId ?? undefined,
      extent: n.parentId ? ('parent' as const) : undefined,
      style: { width: n.width, height: n.height },
      selectable: true,
      draggable: editing,
      zIndex: n.type === 'area' ? 0 : 2,
    }));

  const edges: Edge[] = arch.edges.map(e => ({
    id: e.id,
    source: e.sourceId,
    target: e.targetId,
    sourceHandle: e.sourceHandle,
    targetHandle: e.targetHandle,
    label: e.label,
    type: 'smoothstep',
    markerEnd: { type: 'arrowclosed' as any, color: edgeStroke },
    style: { stroke: edgeStroke, strokeWidth: 1.25 },
    selectable: true,
    updatable: editing,
    zIndex: 1,
  }));

  return { nodes, edges };
}

function flowToArch(nodes: Node[], edges: Edge[]): Architecture {
  const archNodes: ArchitectureNode[] = nodes.map((n, idx) => ({
    id: n.id,
    type: (n.type === 'area' ? 'area' : n.type === 'group' ? 'group' : 'box') as NodeType,
    label: (n.data as any)?.label ?? '',
    description: (n.data as any)?.description,
    x: n.position.x,
    y: n.position.y,
    width: Number(n.width ?? n.measured?.width ?? (n.style as any)?.width ?? 200),
    height: Number(n.height ?? n.measured?.height ?? (n.style as any)?.height ?? 120),
    parentId: n.parentId ?? null,
    zOrder: idx,
  }));
  const archEdges: ArchitectureEdge[] = edges.map(e => ({
    id: e.id,
    sourceId: e.source,
    targetId: e.target,
    sourceHandle: e.sourceHandle ?? undefined,
    targetHandle: e.targetHandle ?? undefined,
    label: typeof e.label === 'string' ? e.label : undefined,
  }));
  return { nodes: archNodes, edges: archEdges };
}

export interface ArchitectureCanvasHandle {
  addBox: () => void;
  addGroup: () => void;
  addArea: () => void;
  deleteSelected: () => void;
  toArchitecture: () => Architecture;
}

export interface ArchitectureCanvasProps {
  architecture: Architecture;
  dashboards: DashboardItem[];
  editing: boolean;
  onSelectNode: (id: string | null) => void;
  onChange: (arch: Architecture) => void;
  onUnassign: (uid: string) => void;
  onSetTier: (uid: string, tier: DashboardTier | null) => void;
  onOpenDashboard: (uid: string, url: string) => void;
  innerRef?: React.MutableRefObject<ArchitectureCanvasHandle | null>;
}

const InnerCanvas = ({
  architecture,
  dashboards,
  editing,
  onSelectNode,
  onChange,
  onUnassign,
  onSetTier,
  onOpenDashboard,
  innerRef,
}: ArchitectureCanvasProps) => {
  const { screenToFlowPosition, getNodes, getViewport, setViewport } =
    useReactFlow();
  const tokens = useThemeTokens();
  // Match the prior MUI dark-theme look: text.primary = rgba(255,255,255,0.87)
  // primary.main = #90caf9. Using fixed values keeps the rendered edge colors
  // identical across the theme migration.
  const edgeStroke = 'rgba(255, 255, 255, 0.87)';
  const edgeSelectedStroke = '#90caf9';

  const restyleEdges = React.useCallback(
    (es: Edge[]): Edge[] =>
      es.map(e => ({
        ...e,
        style: {
          stroke: e.selected ? edgeSelectedStroke : edgeStroke,
          strokeWidth: e.selected ? 2.5 : 1.25,
        },
        markerEnd: {
          type: 'arrowclosed' as any,
          color: e.selected ? edgeSelectedStroke : edgeStroke,
        },
      })),
    [edgeStroke, edgeSelectedStroke],
  );
  const [nodes, setNodes] = React.useState<Node[]>(() => archToFlow(architecture, editing, edgeStroke).nodes);
  const [edges, setEdges] = React.useState<Edge[]>(() => archToFlow(architecture, editing, edgeStroke).edges);

  const lastEchoRef = React.useRef<string>('');
  const nodesRef = React.useRef<Node[]>(nodes);
  const edgesRef = React.useRef<Edge[]>(edges);
  nodesRef.current = nodes;
  edgesRef.current = edges;

  const MAX_HISTORY = 50;
  const historyRef = React.useRef<Array<{ nodes: Node[]; edges: Edge[] }>>([]);
  const draggingNodesRef = React.useRef<Set<string>>(new Set());
  const resizingNodesRef = React.useRef<Set<string>>(new Set());

  const pushHistory = React.useCallback(() => {
    historyRef.current = [
      ...historyRef.current.slice(-(MAX_HISTORY - 1)),
      { nodes: nodesRef.current, edges: edgesRef.current },
    ];
  }, []);

  const undo = React.useCallback(() => {
    if (historyRef.current.length === 0) return;
    const prev = historyRef.current[historyRef.current.length - 1];
    historyRef.current = historyRef.current.slice(0, -1);
    setNodes(sortNodes(prev.nodes));
    setEdges(prev.edges);
  }, []);

  React.useEffect(() => {
    historyRef.current = [];
    draggingNodesRef.current.clear();
    resizingNodesRef.current.clear();
  }, [editing]);

  React.useEffect(() => {
    if (!editing) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [editing, undo]);

  // Stable callbacks injected into node data for inline editing.
  const onLabelChange = React.useCallback((id: string, label: string) => {
    setNodes(curr =>
      curr.map(n =>
        n.id === id ? { ...n, data: { ...n.data, label } } : n,
      ),
    );
  }, []);

  const onDescriptionChange = React.useCallback((id: string, description: string) => {
    setNodes(curr =>
      curr.map(n =>
        n.id === id
          ? { ...n, data: { ...n.data, description } }
          : n,
      ),
    );
  }, []);

  const onUnassignRef = React.useRef(onUnassign);
  const onSetTierRef = React.useRef(onSetTier);
  const onOpenRef = React.useRef(onOpenDashboard);
  onUnassignRef.current = onUnassign;
  onSetTierRef.current = onSetTier;
  onOpenRef.current = onOpenDashboard;

  // Sync from external prop change. Skip self-echoes.
  React.useEffect(() => {
    const archStr = JSON.stringify(architecture);
    if (archStr === lastEchoRef.current) return;
    const next = archToFlow(architecture, editing, edgeStroke);
    setNodes(next.nodes);
    setEdges(next.edges);
    lastEchoRef.current = JSON.stringify(flowToArch(next.nodes, next.edges));
  }, [architecture, editing, edgeStroke]);

  // Refresh per-node `data.dashboards` and `data.counts` when dashboards change
  // or when the node id list changes. Also (re)inject callbacks so the latest
  // closures are used. None of these mutations alter flowToArch output (which
  // only reads label/description), so they don't trigger an emit.
  React.useEffect(() => {
    setNodes(prev =>
      prev.map(n => {
        if (!HOST_TYPES.includes(n.type as NodeType)) {
          return {
            ...n,
            data: {
              ...n.data,
              editing,
              onLabelChange,
              onDescriptionChange,
            },
          };
        }
        return {
          ...n,
          data: {
            ...n.data,
            editing,
            dashboards: dashboardsFor(n.id, dashboards),
            counts: tierCounts(n.id, dashboards),
            onLabelChange,
            onDescriptionChange,
            onUnassign: (uid: string) => onUnassignRef.current(uid),
            onSetTier: (uid: string, t: DashboardTier | null) =>
              onSetTierRef.current(uid, t),
            onOpenDashboard: (uid: string, url: string) =>
              onOpenRef.current(uid, url),
          },
        };
      }),
    );
  }, [dashboards, editing, architecture, onLabelChange, onDescriptionChange]);

  // Emit when state changes during editing, dedup via JSON.
  React.useEffect(() => {
    if (!editing) return;
    const a = flowToArch(nodes, edges);
    const s = JSON.stringify(a);
    if (s === lastEchoRef.current) return;
    lastEchoRef.current = s;
    onChange(a);
  }, [nodes, edges, editing, onChange]);

  const onNodesChange = React.useCallback((changes: NodeChange[]) => {
    let shouldPush = false;
    for (const change of changes) {
      if (change.type === 'position') {
        if (change.dragging && !draggingNodesRef.current.has(change.id)) {
          draggingNodesRef.current.add(change.id);
          shouldPush = true;
        } else if (!change.dragging) {
          draggingNodesRef.current.delete(change.id);
        }
      } else if (change.type === 'dimensions') {
        if (change.resizing && !resizingNodesRef.current.has(change.id)) {
          resizingNodesRef.current.add(change.id);
          shouldPush = true;
        } else if (!change.resizing) {
          resizingNodesRef.current.delete(change.id);
        }
      } else if (change.type === 'remove') {
        shouldPush = true;
      }
    }
    if (shouldPush) pushHistory();
    setNodes(curr => sortNodes(applyNodeChanges(changes, curr)));
  }, [pushHistory]);

  const onEdgesChange = React.useCallback((changes: EdgeChange[]) => {
    if (changes.some(c => c.type === 'remove')) pushHistory();
    setEdges(curr => restyleEdges(applyEdgeChanges(changes, curr)));
  }, [pushHistory, restyleEdges]);

  const onConnect = React.useCallback((conn: Connection) => {
    pushHistory();
    setEdges(curr => {
      const id = `e_${conn.source}_${conn.target}_${Date.now()}`;
      return restyleEdges(
        addEdge(
          {
            ...conn,
            id,
            sourceHandle: conn.sourceHandle ?? undefined,
            targetHandle: conn.targetHandle ?? undefined,
            type: 'smoothstep',
            zIndex: 1,
          },
          curr,
        ),
      );
    });
  }, [pushHistory, restyleEdges]);

  const onSelectionChange = React.useCallback(
    ({ nodes: selected }: { nodes: Node[]; edges: Edge[] }) => {
      onSelectNode(selected[0]?.id ?? null);
    },
    [onSelectNode],
  );

  const baseHostData = React.useCallback(() => ({
    editing: true,
    onLabelChange,
    onDescriptionChange,
    onUnassign: (uid: string) => onUnassignRef.current(uid),
    onSetTier: (uid: string, t: DashboardTier | null) =>
      onSetTierRef.current(uid, t),
    onOpenDashboard: (uid: string, url: string) =>
      onOpenRef.current(uid, url),
  }), [onLabelChange, onDescriptionChange]);

  const onExportImage = React.useCallback(async () => {
    const flowEl = document.querySelector('.react-flow') as HTMLElement | null;
    if (!flowEl) return;
    const PADDING = 32;
    const bounds = getNodesBounds(getNodes());
    const width = Math.max(1, Math.ceil(bounds.width + PADDING * 2));
    const height = Math.max(1, Math.ceil(bounds.height + PADDING * 2));
    const transform = getViewportForBounds(
      bounds,
      width,
      height,
      0.5,
      2,
      PADDING,
    );
    const previousViewport = getViewport();
    setViewport(transform, { duration: 0 });
    await new Promise(r => requestAnimationFrame(() => r(null)));
    try {
      const dataUrl = await toPng(flowEl, {
        backgroundColor: tokens.bgApp,
        width,
        height,
        style: { width: `${width}px`, height: `${height}px` },
        filter: node => {
          if (!(node instanceof HTMLElement)) return true;
          const cl = node.classList;
          return !(
            cl.contains('react-flow__minimap') ||
            cl.contains('react-flow__controls') ||
            cl.contains('react-flow__panel') ||
            cl.contains('react-flow__attribution') ||
            cl.contains('react-flow__background')
          );
        },
      });
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = `dashboard-map-${new Date().toISOString().slice(0, 10)}.png`;
      a.click();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Image export failed', err);
    } finally {
      setViewport(previousViewport, { duration: 0 });
    }
  }, [getNodes, getViewport, setViewport, tokens.bgApp]);

  React.useImperativeHandle(
    innerRef,
    () => ({
      addBox: () => {
        const center = screenToFlowPosition({
          x: window.innerWidth / 2,
          y: window.innerHeight / 2,
        });
        const id = `n_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const w = 240;
        const h = 192;
        const newNode: Node = {
          id,
          type: 'box',
          position: { x: snap(center.x - w / 2), y: snap(center.y - h / 2) },
          width: w,
          height: h,
          data: {
            label: 'New box',
            ...baseHostData(),
            dashboards: [],
            counts: EMPTY_COUNTS,
          },
          style: { width: w, height: h },
          zIndex: 2,
        };
        pushHistory();
        setNodes(curr => sortNodes([...curr, newNode]));
      },
      addGroup: () => {
        const center = screenToFlowPosition({
          x: window.innerWidth / 2,
          y: window.innerHeight / 2,
        });
        const id = `u_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const w = 240;
        const h = 192;
        const newNode: Node = {
          id,
          type: 'group',
          position: { x: snap(center.x - w / 2), y: snap(center.y - h / 2) },
          width: w,
          height: h,
          data: {
            label: 'New group',
            ...baseHostData(),
            dashboards: [],
            counts: EMPTY_COUNTS,
          },
          style: { width: w, height: h },
          zIndex: 2,
        };
        pushHistory();
        setNodes(curr => sortNodes([...curr, newNode]));
      },
      addArea: () => {
        const center = screenToFlowPosition({
          x: window.innerWidth / 2,
          y: window.innerHeight / 2,
        });
        const id = `a_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const w = 384;
        const h = 256;
        const newNode: Node = {
          id,
          type: 'area',
          position: { x: snap(center.x - w / 2), y: snap(center.y - h / 2) },
          width: w,
          height: h,
          data: {
            label: 'New area',
            editing: true,
            onLabelChange,
            onDescriptionChange,
          },
          style: { width: w, height: h },
          selectable: true,
          zIndex: 0,
        };
        pushHistory();
        setNodes(curr => sortNodes([...curr, newNode]));
      },
      deleteSelected: () => {
        const cur = nodesRef.current;
        const curEdges = edgesRef.current;
        const selectedIds = new Set(cur.filter(n => n.selected).map(n => n.id));
        const selectedEdges = new Set(curEdges.filter(e => e.selected).map(e => e.id));
        if (selectedIds.size === 0 && selectedEdges.size === 0) return;
        const nextNodes = cur.filter(
          n => !selectedIds.has(n.id) && !(n.parentId && selectedIds.has(n.parentId)),
        );
        const nextEdges = curEdges.filter(
          e =>
            !selectedEdges.has(e.id) &&
            !selectedIds.has(e.source) &&
            !selectedIds.has(e.target),
        );
        pushHistory();
        setNodes(sortNodes(nextNodes));
        setEdges(nextEdges);
        onSelectNode(null);
      },
      toArchitecture: () => flowToArch(nodesRef.current, edgesRef.current),
    }),
    [screenToFlowPosition, onSelectNode, baseHostData, onLabelChange, onDescriptionChange, pushHistory],
  );

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={NODE_TYPES as any}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={editing ? onConnect : undefined}
      onSelectionChange={onSelectionChange}
      nodesDraggable={editing}
      nodesConnectable={editing}
      connectionMode={ConnectionMode.Loose}
      elementsSelectable
      elevateNodesOnSelect={false}
      elevateEdgesOnSelect={false}
      edgesFocusable={editing}
      edgesReconnectable={false}
      deleteKeyCode={editing ? ['Backspace', 'Delete'] : null}
      panOnDrag={false}
      panOnScroll={false}
      zoomOnScroll
      zoomOnPinch
      zoomOnDoubleClick={false}
      selectionOnDrag={editing}
      snapToGrid={editing}
      snapGrid={[GRID, GRID]}
      fitView
      minZoom={0.2}
      maxZoom={2}
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={GRID} size={1} />
      <Controls showInteractive={false}>
        <ControlButton onClick={onExportImage} title="Save as image">
          <RiCameraLine size={14} />
        </ControlButton>
      </Controls>
      <MiniMap pannable zoomable />
    </ReactFlow>
  );
};

export const ArchitectureCanvas = (props: ArchitectureCanvasProps) => {
  return (
    <div className="gdm-canvas-wrapper">
      <ReactFlowProvider>
        <InnerCanvas {...props} />
      </ReactFlowProvider>
    </div>
  );
};
