import { createApiRef } from '@backstage/core-plugin-api';
import { LogExtractRequest } from './types';

export interface S3Config {
  bucket: string;
  region: string;
  prefix: string;
  maxTimeRangeMinutes: number;
}

export interface S3HealthStatus {
  connected: boolean;
  checkedAt: string;
  error?: string;
}

export interface S3LogExtractApi {
  getConfig(): Promise<S3Config>;
  getS3Health(): Promise<S3HealthStatus>;
  listApps(env: string, date: string, source: string): Promise<string[]>;
  createRequest(input: {
    source: string;
    env: string;
    date: string;
    apps: string[];
    startTime: string;
    endTime: string;
    reason: string;
  }): Promise<LogExtractRequest>;
  listRequests(): Promise<LogExtractRequest[]>;
  getRequest(id: string): Promise<LogExtractRequest>;
  reviewRequest(
    id: string,
    input: { action: 'approve' | 'reject'; comment: string },
  ): Promise<LogExtractRequest>;
  downloadUrl(id: string): Promise<string>;
  getAdminStatus(): Promise<{ isAdmin: boolean }>;
}

export const s3LogExtractApiRef = createApiRef<S3LogExtractApi>({
  id: 'plugin.s3-log-extract.api',
});
