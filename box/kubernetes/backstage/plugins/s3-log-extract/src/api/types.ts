export type RequestStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'extracting'
  | 'completed'
  | 'failed';

export type Environment = 'dev' | 'stg' | 'sb' | 'prd';

export type LogSource = 'k8s' | 'ec2';

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
  createdAt: string;
  updatedAt: string;
}
