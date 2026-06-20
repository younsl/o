// Thin fetch wrapper around the forklift management API. Auth is cookie-based
// (set by POST /api/v1/login), so requests just need credentials: "include".

export interface RepoConfig {
  cache: {
    enabled: boolean;
    artifact_ttl: string;
    metadata_ttl: string;
    negative_ttl: string;
    max_size_bytes: number;
    eviction: string;
  };
  age_policy: {
    enabled: boolean;
    min_age: string;
    max_age: string;
    action: string;
  };
  approval: {
    enabled: boolean;
    mode?: string;
    auto_approve?: string[];
  };
  retention?: {
    idle_ttl?: string;
  };
  vuln?: {
    enabled: boolean;
    threshold?: string;
    action?: string;
    ignore?: string[];
    block_unscanned?: boolean;
  };
  group: {
    members?: string[];
  };
}

// RepoPermission is a role permission that grants access to a repository (its
// pattern matched the repo name), with the granting role and its user count.
export interface RepoPermission {
  role_id: number;
  role: string;
  repo_pattern: string;
  actions: string[];
  user_count: number;
}

// RepoToken is a personal access token that can reach a repository: a scoped
// token whose pattern matched, or an unscoped token inheriting the owner roles.
export interface RepoToken {
  token_id: number;
  name: string;
  owner: string;
  repo_pattern: string;
  actions: string[];
  unscoped: boolean;
  expires_at: string | null;
  last_used_at: string | null;
}

export interface Repository {
  id: number;
  name: string;
  format: string;
  type: string;
  upstream_url: string;
  config: RepoConfig;
  disabled: boolean;
  // Artifact aggregates, present in list responses only.
  artifact_count?: number;
  total_size?: number;
}

// RepositoryName is the slim repository shape returned by /repository-names for
// token-scope autocomplete (available to any authenticated user).
export interface RepositoryName {
  name: string;
  format: string;
  type: string;
}

export interface Me {
  authenticated: boolean;
  username?: string;
  source?: string;
  admin?: boolean;
  // approver: may decide package approvals (admin, or a role with the approve action).
  approver?: boolean;
  // auditor: may read the admin surfaces read-only (admin, or a role with the audit action).
  auditor?: boolean;
}

export interface Version {
  version: string;
  commit: string;
  oidc_enabled: boolean;
}

export interface Token {
  id: number;
  name: string;
  description: string;
  scopes_json: string;
  expires_at: string | null;
  last_used_at: string | null;
  created_at: string;
}

export interface Artifact {
  path: string;
  version: string;
  size: number;
  content_type: string;
  published_at: string | null;
  cached_at: string;
  last_accessed_at: string;
  max_severity?: string;
  vuln_ids?: string[];
}

export interface ArtifactList {
  count: number;
  total_size: number;
  artifacts: Artifact[];
}

export interface RoleRef {
  id: number;
  name: string;
}

export interface User {
  id: number;
  username: string;
  source: string;
  email: string;
  disabled: boolean;
  created_at: string;
  last_login_at: string | null;
  roles: RoleRef[];
  lockout_enabled: boolean;
  locked: boolean;
  // protected: the default admin, which cannot be locked out.
  protected: boolean;
}

export interface Permission {
  id: number;
  repo_pattern: string;
  actions: string[];
}

export interface Role {
  id: number;
  name: string;
  description: string;
  created_at: string;
  permissions: Permission[];
  user_count: number;
  // managed: declared via the chart (declarative RBAC) vs created in the UI.
  managed: boolean;
}

export interface AuditLog {
  id: number;
  event: string;
  path: string;
  username: string;
  method: string;
  status: number;
  client_ip: string;
  user_agent: string;
  created_at: string;
}

export interface AuditLogList {
  count: number;
  logs: AuditLog[];
}

export interface Approval {
  id: number;
  repo_name: string;
  package: string;
  status: string;
  requested_by: string;
  decided_by: string;
  note: string;
  request_count: number;
  last_requested_version: string;
  first_requested_at: string;
  last_requested_at: string;
  decided_at: string | null;
  vuln_severity?: string;
  vuln_ids?: string[];
  vuln_scope?: string;
  vuln_counts?: Record<string, number>;
  vuln_advisories?: { id: string; severity: string; score?: string }[];
  vuln_source?: string;
  vuln_scanned_at?: string;
  vuln_scan_ms?: number;
  reviewers?: string[];
}

export interface ApprovalList {
  count: number;
  approvals: Approval[];
}

export interface VersionDeny {
  id: number;
  repo_name: string;
  package: string;
  version: string;
  reason: string;
  created_by: string;
  created_at: string;
}

export interface VersionDenyList {
  count: number;
  denies: VersionDeny[];
}

export interface UpstreamHealth {
  applicable: boolean;
  reachable?: boolean;
  status?: number;
  latency_ms?: number;
  error?: string;
}

// repoEndpoint returns the forklift-relative call address for a repository, by
// format, plus where the client configures it.
export function repoEndpoint(format: string, name: string): { url: string; hint: string } {
  const base = window.location.origin;
  switch (format) {
    case "maven":
      return { url: `${base}/maven/${name}/`, hint: "settings.xml <mirror><url>" };
    case "npm":
      return { url: `${base}/npm/${name}/`, hint: ".npmrc registry=" };
    case "cargo":
      return { url: `sparse+${base}/cargo/${name}/`, hint: ".cargo/config.toml [registries]" };
    case "go":
      return { url: `${base}/go/${name}`, hint: "GOPROXY=" };
    case "pypi":
      return { url: `${base}/pypi/${name}/simple/`, hint: "pip index-url / twine repository url" };
    default:
      return { url: `${base}/${format}/${name}/`, hint: "" };
  }
}

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${units[i]}`;
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    method,
    credentials: "include",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  // Error bodies are not always JSON (e.g. middleware returns plaintext
  // "forbidden" / "unauthorized"), so parse defensively and fall back to the
  // raw text instead of throwing a misleading "Unexpected token" parse error.
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  if (!res.ok) {
    const fromJson = (data as { error?: string } | undefined)?.error;
    throw new Error(fromJson || text.trim() || res.statusText);
  }
  return data as T;
}

export const api = {
  me: () => req<Me>("GET", "/me"),
  login: (username: string, password: string) =>
    req<{ username: string }>("POST", "/login", { username, password }),
  logout: () => req<void>("POST", "/logout"),
  version: () => req<Version>("GET", "/version"),

  listRepositories: () => req<Repository[]>("GET", "/repositories"),
  listRepositoryNames: () => req<RepositoryName[]>("GET", "/repository-names"),
  getRepository: (id: number) => req<Repository>("GET", `/repositories/${id}`),
  createRepository: (body: unknown) => req<Repository>("POST", "/repositories", body),
  updateRepository: (id: number, body: unknown) =>
    req<Repository>("PUT", `/repositories/${id}`, body),
  deleteRepository: (id: number) => req<void>("DELETE", `/repositories/${id}`),
  repositoryPermissions: (id: number) =>
    req<RepoPermission[]>("GET", `/repositories/${id}/permissions`),
  repositoryTokens: (id: number) =>
    req<RepoToken[]>("GET", `/repositories/${id}/tokens`),
  setRepositoryDisabled: (id: number, disabled: boolean) =>
    req<Repository>("POST", `/repositories/${id}/disabled`, { disabled }),

  listArtifacts: (id: number, prefix = "") =>
    req<ArtifactList>("GET", `/repositories/${id}/artifacts?prefix=${encodeURIComponent(prefix)}`),
  deleteArtifact: (id: number, path: string) =>
    req<void>("DELETE", `/repositories/${id}/artifacts?path=${encodeURIComponent(path)}`),
  purgeArtifacts: (id: number) =>
    req<{ deleted: number }>("DELETE", `/repositories/${id}/artifacts`),
  upstreamHealth: (id: number) => req<UpstreamHealth>("GET", `/repositories/${id}/upstream-health`),
  checkUpstream: (url: string) => req<UpstreamHealth>("POST", "/repositories/check-upstream", { url }),
  listAuditLogs: (id: number, event = "", limit = 100, offset = 0) =>
    req<AuditLogList>(
      "GET",
      `/repositories/${id}/audit-logs?event=${encodeURIComponent(event)}&limit=${limit}&offset=${offset}`,
    ),

  listUsers: () => req<User[]>("GET", "/users"),
  createUser: (body: { username: string; password: string; email?: string; role_ids?: number[] }) =>
    req<{ id: number; username: string }>("POST", "/users", body),
  updateUser: (id: number, body: { password?: string; disabled?: boolean; lockout_enabled?: boolean; unlock?: boolean }) =>
    req<User>("PUT", `/users/${id}`, body),
  deleteUser: (id: number) => req<void>("DELETE", `/users/${id}`),
  assignRole: (userId: number, roleId: number) =>
    req<void>("POST", `/users/${userId}/roles`, { role_id: roleId }),
  removeRole: (userId: number, roleId: number) =>
    req<void>("DELETE", `/users/${userId}/roles/${roleId}`),

  listRoles: () => req<Role[]>("GET", "/roles"),
  createRole: (body: { name: string; description?: string; permissions?: { repo_pattern: string; actions: string[] }[] }) =>
    req<Role>("POST", "/roles", body),
  deleteRole: (id: number) => req<void>("DELETE", `/roles/${id}`),
  addPermission: (roleId: number, body: { repo_pattern: string; actions: string[] }) =>
    req<Permission>("POST", `/roles/${roleId}/permissions`, body),
  deletePermission: (roleId: number, permId: number) =>
    req<void>("DELETE", `/roles/${roleId}/permissions/${permId}`),

  listApprovals: (repo = "", status = "", limit = 100, offset = 0) =>
    req<ApprovalList>(
      "GET",
      `/approvals?repo=${encodeURIComponent(repo)}&status=${encodeURIComponent(status)}&limit=${limit}&offset=${offset}`,
    ),
  approvalCount: (status = "pending", repo = "") =>
    req<{ count: number }>(
      "GET",
      `/approvals/count?status=${encodeURIComponent(status)}&repo=${encodeURIComponent(repo)}`,
    ),
  getApproval: (id: number) => req<Approval>("GET", `/approvals/${id}`),
  createApproval: (body: { repo: string; package: string; status: string; note?: string }) =>
    req<Approval>("POST", "/approvals", body),
  approveAllPending: (repo: string, note = "") =>
    req<{ approved: number }>("POST", "/approvals/approve-all", { repo, note }),
  approveApproval: (id: number, note = "") =>
    req<Approval>("POST", `/approvals/${id}/approve`, { note }),
  rejectApproval: (id: number, note = "") =>
    req<Approval>("POST", `/approvals/${id}/reject`, { note }),

  listVersionDenies: (repo = "", limit = 100, offset = 0) =>
    req<VersionDenyList>(
      "GET",
      `/version-denies?repo=${encodeURIComponent(repo)}&limit=${limit}&offset=${offset}`,
    ),
  createVersionDeny: (body: { repo: string; package: string; version: string; reason?: string }) =>
    req<VersionDeny>("POST", "/version-denies", body),
  deleteVersionDeny: (id: number) => req<void>("DELETE", `/version-denies/${id}`),

  listTokens: () => req<Token[]>("GET", "/tokens"),
  createToken: (body: unknown) => req<{ token: string; name: string }>("POST", "/tokens", body),
  deleteToken: (id: number) => req<void>("DELETE", `/tokens/${id}`),
};
