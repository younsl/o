export type RequestStatus =
  | 'scheduled'
  | 'validating'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type AuditEventType =
  | 'submitted'
  | 'executed'
  | 'failed'
  | 'cancelled'
  | 'completed';

export interface AuditEvent {
  id: string;
  eventType: AuditEventType;
  actor: string;
  note: string | null;
  createdAt: string;
}

export interface DomainSnapshot {
  instanceType: string | null;
  instanceCount: number | null;
  volumeSizeGb: number | null;
}

export interface ScalingRequest {
  id: string;
  domain: string;
  instanceType: string;
  instanceCount: number;
  volumeSizeGb: number;
  currentSnapshot: DomainSnapshot | null;
  /** Absolute reserved execution instant (UTC ISO 8601). */
  scheduledAt: string;
  /** IANA timezone the requester reserved the time in. */
  timezone: string;
  requester: string;
  reason: string | null;
  status: RequestStatus;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  auditEvents: AuditEvent[];
}

/** A domain name paired with its engine version, for the domain selector. */
export interface DomainSummary {
  name: string;
  engineVersion: string | null;
}

/** Current domain config plus the in-progress flag, for form pre-validation. */
export interface DomainDetail extends DomainSnapshot {
  name: string;
  engineVersion: string | null;
  processing: boolean;
  upgradeProcessing: boolean;
  changeInProgress: boolean;
  /** Valid data-node instance types for this domain (from the AWS API). */
  instanceTypes: string[];
}

export interface ScalingConfig {
  configured: boolean;
  instanceTypes: string[];
  timezones: string[];
  defaultTimezone: string;
}

export interface UserRole {
  isAdmin: boolean;
  admins: string[];
}

/** AWS dry-run result: how the change would be applied. */
export interface ScalingPreview {
  /** "Blue/Green" | "DynamicUpdate" | "None" | "Undetermined" */
  deploymentType: string | null;
  message: string | null;
}

/** Target spec for a scaling change, shared by create and preview. */
export interface ScalingTargetInput {
  instanceType: string;
  instanceCount: number;
  volumeSizeGb: number;
}

export interface CreateScalingInput {
  domain: string;
  instanceType: string;
  instanceCount: number;
  volumeSizeGb: number;
  /** Absolute reserved instant (UTC ISO 8601). */
  scheduledAt: string;
  timezone: string;
  reason: string;
}
