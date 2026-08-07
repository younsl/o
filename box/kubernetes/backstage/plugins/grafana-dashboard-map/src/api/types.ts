export type DashboardTier = 'L1' | 'L2' | 'L3';

export const DASHBOARD_TIERS: DashboardTier[] = ['L1', 'L2', 'L3'];

export const TIER_DESCRIPTIONS: Record<DashboardTier, string> = {
  L1: 'Overview — high-level KPIs and summary',
  L2: 'Service — per-service monitoring and drill-down',
  L3: 'Deep dive — detailed debugging and low-level metrics',
};

export type NodeType = 'box' | 'area' | 'group';

export type DashboardAlertState = 'firing' | 'ok';

export interface Diagram {
  id: string;
  name: string;
  description?: string;
  position: number;
  createdBy?: string;
  createdAt?: string;
  updatedBy?: string;
  updatedAt?: string;
}

export interface DiagramsResponse {
  diagrams: Diagram[];
}

export interface ArchitectureNode {
  id: string;
  type: NodeType;
  label: string;
  description?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  parentId: string | null;
  zOrder: number;
}

export interface ArchitectureEdge {
  id: string;
  sourceId: string;
  targetId: string;
  sourceHandle?: string;
  targetHandle?: string;
  label?: string;
}

export interface Architecture {
  nodes: ArchitectureNode[];
  edges: ArchitectureEdge[];
  lastSavedAt?: string;
  lastSavedBy?: string;
}

export interface DashboardItem {
  uid: string;
  title: string;
  url: string;
  folder?: string;
  tags: string[];
  nodeId: string | null;
  position: number;
  tier: DashboardTier | null;
  clickCount: number;
  lastClickedAt?: string;
  alertState: DashboardAlertState;
  firingCount: number;
  alertCount: number;
  alertRules: DashboardAlertRule[];
}

export interface DashboardAlertRule {
  name: string;
  firing: boolean;
}

export interface DashboardAssignment {
  dashboardUid: string;
  nodeId: string;
  position: number;
  tier: DashboardTier | null;
}

export interface DashboardsResponse {
  dashboards: DashboardItem[];
  tiers: DashboardTier[];
}

export interface AdminStatus {
  isAdmin: boolean;
}
