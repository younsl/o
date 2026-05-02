export type DashboardTier = 'L1' | 'L2' | 'L3';

export const DASHBOARD_TIERS: DashboardTier[] = ['L1', 'L2', 'L3'];

export type DashboardAlertState = 'firing' | 'ok';

export type NodeType = 'box' | 'area' | 'group';

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

export interface DashboardAssignment {
  dashboardUid: string;
  nodeId: string;
  position: number;
  tier: DashboardTier | null;
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

export interface DashboardsResponse {
  dashboards: DashboardItem[];
  tiers: DashboardTier[];
}

export interface GrafanaSearchResult {
  uid: string;
  title: string;
  url: string;
  folderTitle?: string;
  tags?: string[];
}
