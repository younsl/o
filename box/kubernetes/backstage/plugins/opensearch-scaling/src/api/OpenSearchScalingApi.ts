import { createApiRef } from '@backstage/core-plugin-api';
import {
  CreateScalingInput,
  DomainDetail,
  DomainSummary,
  ScalingConfig,
  ScalingPreview,
  ScalingRequest,
  ScalingTargetInput,
  UserRole,
} from './types';

export interface OpenSearchScalingApi {
  getConfig(): Promise<ScalingConfig>;
  getUserRole(): Promise<UserRole>;
  listDomains(): Promise<DomainSummary[]>;
  getDomain(name: string): Promise<DomainDetail>;
  previewScaling(
    domain: string,
    target: ScalingTargetInput,
  ): Promise<ScalingPreview>;
  listRequests(): Promise<ScalingRequest[]>;
  createRequest(input: CreateScalingInput): Promise<ScalingRequest>;
  cancelRequest(id: string): Promise<ScalingRequest>;
}

export const opensearchScalingApiRef = createApiRef<OpenSearchScalingApi>({
  id: 'plugin.opensearch-scaling.api',
});
