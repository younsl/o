import { createApiRef } from '@backstage/core-plugin-api';
import {
  AdminStatus,
  Architecture,
  DashboardAssignment,
  DashboardsResponse,
  Diagram,
} from './types';

export interface CreateDiagramInput {
  id: string;
  name: string;
  description?: string;
}

export interface UpdateDiagramInput {
  name?: string;
  description?: string | null;
  position?: number;
}

export interface GrafanaDashboardMapApi {
  listDiagrams(): Promise<Diagram[]>;
  createDiagram(input: CreateDiagramInput): Promise<Diagram>;
  updateDiagram(id: string, patch: UpdateDiagramInput): Promise<Diagram>;
  deleteDiagram(id: string): Promise<void>;

  getDashboards(diagramId: string): Promise<DashboardsResponse>;
  saveAssignments(
    diagramId: string,
    assignments: DashboardAssignment[],
  ): Promise<void>;
  getArchitecture(diagramId: string): Promise<Architecture>;
  saveArchitecture(diagramId: string, arch: Architecture): Promise<void>;

  getAdminStatus(): Promise<AdminStatus>;
  recordClick(uid: string): Promise<void>;
}

export const grafanaDashboardMapApiRef = createApiRef<GrafanaDashboardMapApi>({
  id: 'plugin.grafana-dashboard-map.api',
});
