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

export interface PrecheckResult {
  candidateCount: number;
  scannedCount: number;
  /** Candidate object count per app, so empty apps are visible in multi-app requests. */
  appCounts: Record<string, number>;
}

export interface S3LogExtractApi {
  getConfig(): Promise<S3Config>;
  getS3Health(): Promise<S3HealthStatus>;
  listApps(env: string, date: string, source: string): Promise<string[]>;
  /**
   * Advisory List-only check of how many S3 objects could overlap the
   * requested window. Zero means extraction would return no files (yet).
   */
  precheck(input: {
    source: string;
    env: string;
    date: string;
    apps: string[];
    startTime: string;
    endTime: string;
  }): Promise<PrecheckResult>;
  createRequest(input: {
    source: string;
    env: string;
    date: string;
    apps: string[];
    startTime: string;
    endTime: string;
    reason: string;
    encryption: string;
  }): Promise<LogExtractRequest>;
  listRequests(): Promise<LogExtractRequest[]>;
  getRequest(id: string): Promise<LogExtractRequest>;
  reviewRequest(
    id: string,
    input: { action: 'approve' | 'reject'; comment: string },
  ): Promise<LogExtractRequest>;
  downloadUrl(id: string): Promise<string>;
  /**
   * Reveal the one-time archive password. Succeeds only for the first caller;
   * afterwards the backend responds 410 and the password is gone for good.
   */
  revealPassword(id: string): Promise<{ password: string }>;
  getAdminStatus(): Promise<{ isAdmin: boolean }>;
}

export const s3LogExtractApiRef = createApiRef<S3LogExtractApi>({
  id: 'plugin.s3-log-extract.api',
});
