export type AccountAction = 'create' | 'delete' | 'modify';
export type RequestStatus = 'pending' | 'executed' | 'rejected' | 'failed';
export type AuditEventType =
  | 'submitted'
  | 'approved'
  | 'rejected'
  | 'executed'
  | 'failed';

export interface InternalUser {
  username: string;
  backendRoles: string[];
  securityRoles: string[];
  reserved: boolean;
  hidden: boolean;
  static: boolean;
}

export interface AuditEvent {
  id: string;
  eventType: AuditEventType;
  actor: string;
  note: string | null;
  createdAt: string;
}

export interface AccountRequest {
  id: string;
  action: AccountAction;
  username: string;
  backendRoles: string[];
  securityRoles: string[];
  attributes: Record<string, string>;
  requester: string;
  reason: string | null;
  reviewer: string | null;
  reviewerNote: string | null;
  status: RequestStatus;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  auditEvents: AuditEvent[];
}

/** A request as returned right after create/approve; password is shown once (modify reset only). */
export type AccountRequestResult = AccountRequest & {
  generatedPassword?: string;
};

export interface CreateRequestInput {
  action: AccountAction;
  username: string;
  /** Required for create: requester-supplied password (hashed server-side). */
  password?: string;
  backendRoles?: string[];
  securityRoles?: string[];
  attributes?: Record<string, string>;
  /** Requester justification; required for create. */
  reason?: string;
  /** Only honored for modify: generate a new password and return it once. */
  resetPassword?: boolean;
}

export interface AccountConfig {
  configured: boolean;
  requiresApproval: boolean;
  /** Master account the plugin authenticates with; protected from deletion. */
  masterUsername: string;
}

export interface UserRole {
  isAdmin: boolean;
  admins: string[];
}
