import { ReactNode, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, Me, Role, Token, User } from "../api";
import { ConfirmModal } from "../components/ConfirmModal";
import { Select } from "../components/Select";
import { Toggle } from "../components/Toggle";

interface Scope {
  repo_pattern: string;
  actions: string[];
}

function parseScopes(json: string): Scope[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

// Per-user modify page: role mapping, password reset, enable/disable, and the
// danger zone (delete). The Users list is read-only; all edits happen here.
export function UserModify({ me }: { me: Me }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const userId = Number(id);
  const [user, setUser] = useState<User | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [tokens, setTokens] = useState<Token[]>([]);
  const [error, setError] = useState("");

  const load = () =>
    Promise.all([api.listUsers(), api.listRoles(), api.listUserTokens(userId)])
      .then(([users, rs, ts]) => {
        const u = users.find((x) => x.id === userId) ?? null;
        setUser(u);
        setRoles(rs);
        setTokens(ts);
        if (!u) setError("User not found.");
      })
      .catch((e) => setError(e.message));
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [userId]);

  if (error && !user) return <div className="error">{error}</div>;
  if (!user) return <div>Loading…</div>;

  const self = user.username === me.username;

  const run = (p: Promise<unknown>) => {
    setError("");
    p.then(load).catch((e) => setError((e as Error).message));
  };

  return (
    <>
      <div className="page-head">
        <h1>{user.username} <span className="badge">{user.source}</span>{self && <span className="badge" style={{ marginLeft: 8 }}>you</span>}</h1>
        <Link className="btn secondary" to="/users">Back to users</Link>
      </div>
      {error && <div className="error">{error}</div>}

      <AccountPanel user={user} />
      <RolesPanel user={user} roles={roles} run={run} canWrite={!!me.admin} />
      <TokensPanel user={user} tokens={tokens} canWrite={!!me.admin} run={run} />
      {me.admin && user.source === "local" && <PasswordPanel user={user} onError={setError} />}
      {me.admin && user.source === "local" && <LockoutPanel user={user} run={run} />}
      {me.admin && <StatusPanel user={user} self={self} run={run} />}
      {me.admin && <DangerPanel user={user} self={self} onDeleted={() => navigate("/users")} onError={setError} />}
    </>
  );
}

// AccountPanel shows the identity fields read-only. Username and email are owned
// by the identity provider (OIDC) or set at creation (local), so they are not
// editable here — only displayed.
function AccountPanel({ user }: { user: User }) {
  return (
    <div className="panel">
      <h2>Account</h2>
      <label>Username</label>
      <input type="text" value={user.username} readOnly />
      <label>Email</label>
      <input type="text" value={user.email || "—"} readOnly />
      <label>Created</label>
      <input type="text" value={user.created_at ? new Date(user.created_at).toLocaleString() : "—"} readOnly />
      <label>Last login</label>
      <input type="text" value={user.last_login_at ? new Date(user.last_login_at).toLocaleString() : "never"} readOnly />
    </div>
  );
}

function RolesPanel({ user, roles, run, canWrite }: { user: User; roles: Role[]; run: (p: Promise<unknown>) => void; canWrite: boolean }) {
  const [selected, setSelected] = useState("");
  const assignable = roles.filter((r) => !user.roles.some((ur) => ur.id === r.id));

  return (
    <div className="panel">
      <h2>Roles</h2>
      <div className="inline" style={{ flexWrap: "wrap", gap: 6 }}>
        {user.roles.map((r) => (
          <span key={r.id} className="badge">
            {r.name}
            {canWrite && (
              <a style={{ marginLeft: 6, cursor: "pointer" }} title="Remove role"
                onClick={() => run(api.removeRole(user.id, r.id))}>×</a>
            )}
          </span>
        ))}
        {user.roles.length === 0 && <span className="muted">No roles assigned.</span>}
      </div>
      {canWrite && assignable.length > 0 && (
        <div className="inline" style={{ marginTop: 12, gap: 6 }}>
          <Select value={selected} onChange={setSelected} placeholder="add role…"
            options={assignable.map((r) => ({ value: String(r.id), label: r.name, description: r.description || undefined }))} />
          <button className="btn secondary" type="button" disabled={!selected}
            onClick={() => { run(api.assignRole(user.id, Number(selected))); setSelected(""); }}>
            Add
          </button>
        </div>
      )}
    </div>
  );
}

// TokensPanel shows the user's personal access tokens. Admins can create
// (via the New token page) and revoke them; auditors see the list read-only.
// Token scopes only ever narrow the user's own role permissions, so issuing a
// token here cannot grant access the user does not already have.
function TokensPanel({ user, tokens, canWrite, run }: {
  user: User; tokens: Token[]; canWrite: boolean; run: (p: Promise<unknown>) => void;
}) {
  const [revokeId, setRevokeId] = useState<number | null>(null);

  return (
    <div className="panel">
      <div className="inline" style={{ justifyContent: "space-between", alignItems: "center" }}>
        <h2 style={{ marginBottom: 0 }}>
          Access tokens <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>· scoped credentials for package clients</span>
        </h2>
        {canWrite && <Link className="btn" to={`/users/${user.id}/tokens/new`}>New token</Link>}
      </div>
      <table style={{ marginTop: 12 }}>
        <thead><tr><th>Name</th><th>Description</th><th>Permissions</th><th>Created</th><th>Expires</th><th>Last used</th>{canWrite && <th></th>}</tr></thead>
        <tbody>
          {tokens.map((t) => (
            <tr key={t.id}>
              <td>{t.name}</td>
              <td className="muted">{t.description}</td>
              <td>
                {parseScopes(t.scopes_json).map((s, i) => (
                  <span key={i} className="badge" style={{ fontFamily: "ui-monospace, monospace", marginRight: 4 }}>
                    {s.repo_pattern}: {s.actions.join(",")}
                  </span>
                ))}
              </td>
              <td className="muted">{t.created_at?.slice(0, 10)}</td>
              <td className="muted">{t.expires_at ? t.expires_at.slice(0, 10) : "never"}</td>
              <td className="muted">{t.last_used_at ? t.last_used_at.slice(0, 10) : "never"}</td>
              {canWrite && <td><button className="btn danger" onClick={() => setRevokeId(t.id)}>Revoke</button></td>}
            </tr>
          ))}
          {tokens.length === 0 && <tr><td colSpan={canWrite ? 7 : 6} className="muted">No tokens yet.</td></tr>}
        </tbody>
      </table>
      {!canWrite && <p className="muted" style={{ marginBottom: 0 }}>Read-only: only administrators can create or revoke tokens.</p>}
      <ConfirmModal
        open={revokeId !== null}
        title="Revoke this token?"
        message="Clients using this token will immediately lose access. This cannot be undone."
        confirmLabel="Revoke"
        danger
        onConfirm={() => { if (revokeId !== null) run(api.deleteUserToken(user.id, revokeId)); setRevokeId(null); }}
        onCancel={() => setRevokeId(null)}
      />
    </div>
  );
}

function PasswordPanel({ user, onError }: { user: User; onError: (e: string) => void }) {
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [saved, setSaved] = useState(false);

  const reset = async () => {
    onError("");
    setSaved(false);
    try {
      await api.updateUser(user.id, { password });
      setPassword("");
      setSaved(true);
    } catch (e) {
      onError((e as Error).message);
    }
  };

  return (
    <div className="panel">
      <h2>Password</h2>
      <label>New password</label>
      <div className="password-field">
        <input type={show ? "text" : "password"} value={password}
          onChange={(e) => { setPassword(e.target.value); setSaved(false); }} />
        <button type="button" className="password-toggle" onClick={() => setShow((s) => !s)}
          aria-label={show ? "Hide password" : "Show password"}>{show ? "Hide" : "Show"}</button>
      </div>
      <div className="inline" style={{ marginTop: 12 }}>
        <button className="btn" type="button" disabled={!password} onClick={reset}>Reset password</button>
        {saved && <span className="muted">Password updated.</span>}
      </div>
    </div>
  );
}

// LockoutPanel toggles failed-password lockout for a local account and unlocks
// it after a lockout. The default admin is protected: the toggle is disabled so
// it can never be locked out of the only guaranteed admin account.
function LockoutPanel({ user, run }: { user: User; run: (p: Promise<unknown>) => void }) {
  return (
    <div className="panel">
      <h2>Account lockout</h2>
      <p className="muted">
        When enabled, the account is locked after 5 consecutive failed password attempts and must be
        unlocked by an administrator. {user.protected && "The default admin account cannot be locked out."}
      </p>
      <Toggle
        checked={user.lockout_enabled}
        disabled={user.protected}
        label={user.lockout_enabled ? "Lockout enabled" : "Lockout disabled"}
        onChange={(v) => run(api.updateUser(user.id, { lockout_enabled: v }))}
      />
      {user.locked && (
        <div className="inline" style={{ marginTop: 14, gap: 10, alignItems: "center" }}>
          <span className="badge" style={{ background: "var(--danger)", color: "#fff" }}>Locked</span>
          <button className="btn" type="button"
            onClick={() => run(api.updateUser(user.id, { unlock: true }))}>
            Unlock account
          </button>
        </div>
      )}
    </div>
  );
}

// LockNote renders an accent-bordered callout with a lock icon, matching the
// managed-role notice. Used to explain why an edit control is locked.
function LockNote({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="panel" style={{ borderColor: "var(--accent)", marginTop: 14, marginBottom: 0 }}>
      <h2 style={{ marginBottom: 8, display: "flex", alignItems: "center", gap: 8, fontSize: 15 }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
          style={{ color: "var(--accent)" }}>
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
        {title}
      </h2>
      <p className="muted" style={{ margin: 0 }}>{children}</p>
    </div>
  );
}

function StatusPanel({ user, self, run }: { user: User; self: boolean; run: (p: Promise<unknown>) => void }) {
  const lockedFromEditing = self || user.protected;
  return (
    <div className="panel">
      <h2>Status</h2>
      <p className="muted">
        An <strong>active</strong> account can sign in to Forklift and use its credentials to pull and publish
        artifacts, while <strong>disabling</strong> immediately revokes that access by stopping all sessions and
        tokens. The account, its tokens and its role assignments are preserved, so disabling is a reversible
        alternative to deletion that you can undo at any time by re-enabling.
      </p>
      <Toggle
        checked={!user.disabled}
        disabled={lockedFromEditing}
        label={user.disabled ? "Account disabled" : "Account active"}
        onChange={(v) => run(api.updateUser(user.id, { disabled: !v }))}
      />
      {user.protected ? (
        <LockNote title="Status locked">
          This is the default administrator account, created when Forklift first started. Its status is locked
          active so the system always keeps at least one administrator who can sign in and recover access. It
          cannot be disabled by anyone, including other administrators.
        </LockNote>
      ) : self && (
        <LockNote title="Status locked">
          You are signed in as this account, so you cannot disable it yourself. This guards against accidentally
          locking yourself out of Forklift. If this account needs to be disabled, ask another administrator to
          do it.
        </LockNote>
      )}
      {user.locked && (
        <p style={{ marginTop: 12, marginBottom: 0 }}>
          <span className="badge" style={{ background: "var(--danger)", color: "#fff" }}>Locked</span>
          <span className="muted" style={{ marginLeft: 8 }}>
            Locked after too many failed password attempts — unlock it in Account lockout.
          </span>
        </p>
      )}
    </div>
  );
}

function DangerPanel({ user, self, onDeleted, onError }: {
  user: User; self: boolean; onDeleted: () => void; onError: (e: string) => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const del = async () => {
    try {
      await api.deleteUser(user.id);
      onDeleted();
    } catch (e) {
      onError((e as Error).message);
    }
  };
  return (
    <div className="panel danger" style={{ marginTop: 18 }}>
      <h2>Danger zone</h2>
      <p className="muted">
        Deleting a user revokes all of their tokens and role assignments. This cannot be undone.
        {self && " You cannot delete your own account."}
      </p>
      <button className="btn danger" type="button" disabled={self} onClick={() => setConfirm(true)}>Delete user</button>
      <ConfirmModal
        open={confirm}
        title={`Delete user "${user.username}"?`}
        message="This revokes all of the user's tokens and role assignments. This cannot be undone."
        confirmLabel="Delete"
        danger
        onConfirm={() => { setConfirm(false); del(); }}
        onCancel={() => setConfirm(false)}
      />
    </div>
  );
}
