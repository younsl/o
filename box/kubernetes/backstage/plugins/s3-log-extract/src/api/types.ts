export type RequestStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'extracting'
  | 'completed'
  | 'failed';

export type Environment = 'dev' | 'stg' | 'sb' | 'prd';

export type LogSource = 'k8s' | 'ec2';

/** Archive encryption method. Only AES-256 is offered. */
export type EncryptionMethod = 'aes256';

export interface LogExtractRequest {
  id: string;
  source: LogSource;
  env: Environment;
  date: string;
  apps: string[];
  startTime: string;
  endTime: string;
  requesterRef: string;
  reason: string;
  encryption: EncryptionMethod;
  status: RequestStatus;
  reviewerRef: string | null;
  reviewComment: string | null;
  fileCount: number | null;
  archiveSize: number | null;
  archivePath: string | null;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  errorMessage: string | null;
  downloadable: boolean;
  // True while the one-time archive password has not been revealed yet.
  passwordAvailable: boolean;
  passwordRevealedTo: string | null;
  passwordRevealedAt: string | null;
  approvalDeadline: string | null;
  extractionDurationMs: number | null;
  progressCurrent: number | null;
  progressTotal: number | null;
  createdAt: string;
  updatedAt: string;
}
