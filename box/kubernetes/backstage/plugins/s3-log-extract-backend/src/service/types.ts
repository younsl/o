export type RequestStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'extracting'
  | 'completed'
  | 'failed';

export type Environment = 'dev' | 'stg' | 'sb' | 'prd';

export type LogSource = 'k8s' | 'ec2';

/**
 * Log stream under an ec2-shortterm app prefix. Only meaningful when
 * source is 'ec2'; k8s has a single stream and stores null.
 */
export type Ec2LogType = 'java' | 'json' | 'nginx' | 'system';

export const EC2_LOG_TYPES: readonly Ec2LogType[] = [
  'java',
  'json',
  'nginx',
  'system',
];

/**
 * Archive encryption method. Only AES-256 is offered: the legacy ZipCrypto
 * alternative is trivially crackable and defeats the leak-protection goal.
 */
export type EncryptionMethod = 'aes256';

export interface LogExtractRequest {
  id: string;
  source: LogSource;
  /** ec2 log stream (java/json/nginx/system); null for k8s. */
  logType: Ec2LogType | null;
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
  // Whether the one-time archive password is still unrevealed. The plaintext
  // password itself is never included in this type (reveal endpoint only).
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

export interface CreateLogExtractInput {
  source: LogSource;
  /**
   * Legacy ec2-only field: default stream for bare app names. New ec2
   * requests carry the category per app entry (`app/nginx`) instead.
   */
  logType?: Ec2LogType;
  env: Environment;
  date: string;
  apps: string[];
  startTime: string;
  endTime: string;
  reason: string;
  encryption: EncryptionMethod;
}

export interface ReviewLogExtractInput {
  action: 'approve' | 'reject';
  comment: string;
}
