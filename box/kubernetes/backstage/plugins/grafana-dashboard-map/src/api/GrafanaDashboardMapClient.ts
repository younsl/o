import { DiscoveryApi, FetchApi } from '@backstage/core-plugin-api';
import { ResponseError } from '@backstage/errors';
import {
  CreateDiagramInput,
  GrafanaDashboardMapApi,
  UpdateDiagramInput,
} from './GrafanaDashboardMapApi';
import {
  AdminStatus,
  Architecture,
  DashboardAssignment,
  DashboardsResponse,
  Diagram,
  DiagramsResponse,
} from './types';

export class GrafanaDashboardMapClient implements GrafanaDashboardMapApi {
  private readonly discoveryApi: DiscoveryApi;
  private readonly fetchApi: FetchApi;

  constructor(options: { discoveryApi: DiscoveryApi; fetchApi: FetchApi }) {
    this.discoveryApi = options.discoveryApi;
    this.fetchApi = options.fetchApi;
  }

  private async getBaseUrl(): Promise<string> {
    return this.discoveryApi.getBaseUrl('grafana-dashboard-map');
  }

  async listDiagrams(): Promise<Diagram[]> {
    const baseUrl = await this.getBaseUrl();
    const response = await this.fetchApi.fetch(`${baseUrl}/diagrams`);
    if (!response.ok) throw await ResponseError.fromResponse(response as any);
    const body: DiagramsResponse = await response.json();
    return body.diagrams;
  }

  async createDiagram(input: CreateDiagramInput): Promise<Diagram> {
    const baseUrl = await this.getBaseUrl();
    const response = await this.fetchApi.fetch(`${baseUrl}/diagrams`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!response.ok) throw await ResponseError.fromResponse(response as any);
    return response.json();
  }

  async updateDiagram(id: string, patch: UpdateDiagramInput): Promise<Diagram> {
    const baseUrl = await this.getBaseUrl();
    const response = await this.fetchApi.fetch(
      `${baseUrl}/diagrams/${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      },
    );
    if (!response.ok) throw await ResponseError.fromResponse(response as any);
    return response.json();
  }

  async deleteDiagram(id: string): Promise<void> {
    const baseUrl = await this.getBaseUrl();
    const response = await this.fetchApi.fetch(
      `${baseUrl}/diagrams/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    );
    if (!response.ok) throw await ResponseError.fromResponse(response as any);
  }

  async getDashboards(diagramId: string): Promise<DashboardsResponse> {
    const baseUrl = await this.getBaseUrl();
    const response = await this.fetchApi.fetch(
      `${baseUrl}/diagrams/${encodeURIComponent(diagramId)}/dashboards`,
    );
    if (!response.ok) throw await ResponseError.fromResponse(response as any);
    return response.json();
  }

  async saveAssignments(
    diagramId: string,
    assignments: DashboardAssignment[],
  ): Promise<void> {
    const baseUrl = await this.getBaseUrl();
    const response = await this.fetchApi.fetch(
      `${baseUrl}/diagrams/${encodeURIComponent(diagramId)}/assignments`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(assignments),
      },
    );
    if (!response.ok) throw await ResponseError.fromResponse(response as any);
  }

  async getArchitecture(diagramId: string): Promise<Architecture> {
    const baseUrl = await this.getBaseUrl();
    const response = await this.fetchApi.fetch(
      `${baseUrl}/diagrams/${encodeURIComponent(diagramId)}/architecture`,
    );
    if (!response.ok) throw await ResponseError.fromResponse(response as any);
    return response.json();
  }

  async saveArchitecture(diagramId: string, arch: Architecture): Promise<void> {
    const baseUrl = await this.getBaseUrl();
    const response = await this.fetchApi.fetch(
      `${baseUrl}/diagrams/${encodeURIComponent(diagramId)}/architecture`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(arch),
      },
    );
    if (!response.ok) throw await ResponseError.fromResponse(response as any);
  }

  async getAdminStatus(): Promise<AdminStatus> {
    const baseUrl = await this.getBaseUrl();
    const response = await this.fetchApi.fetch(`${baseUrl}/admin-status`);
    if (!response.ok) return { isAdmin: false };
    return response.json();
  }

  async recordClick(uid: string): Promise<void> {
    try {
      const baseUrl = await this.getBaseUrl();
      await this.fetchApi.fetch(
        `${baseUrl}/clicks/${encodeURIComponent(uid)}`,
        { method: 'POST' },
      );
    } catch {
      /* fire-and-forget; never block dashboard navigation on telemetry */
    }
  }
}
