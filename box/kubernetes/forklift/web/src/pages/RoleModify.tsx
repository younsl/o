import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, Me, Role, User } from "../api";
import { ConfirmModal } from "../components/ConfirmModal";
import { Combobox } from "../components/Combobox";

const ACTIONS = ["read", "write", "delete", "approve", "audit", "admin"];

// Per-role modify page: permission mapping, assigned users, and the danger zone
// (delete). The Roles list is read-only; all edits happen here. The page is
// read-only (no add/remove permission, no delete) for an auditor and for managed
// roles, which are owned by the chart's declarative RBAC policy.
export function RoleModify({ me }: { me: Me }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const roleId = Number(id);
  const [role, setRole] = useState<Role | null>(null);
  const [members, setMembers] = useState<User[]>([]);
  const [error, setError] = useState("");

  const load = () =>
    Promise.all([api.listRoles(), api.listUsers()])
      .then(([roles, users]) => {
        const r = roles.find((x) => x.id === roleId) ?? null;
        setRole(r);
        setMembers(users.filter((u) => u.roles.some((ur) => ur.id === roleId)));
        if (!r) setError("Role not found.");
      })
      .catch((e) => setError(e.message));
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [roleId]);

  if (error && !role) return <div className="error">{error}</div>;
  if (!role) return <div>Loading…</div>;

  const run = (p: Promise<unknown>) => {
    setError("");
    p.then(load).catch((e) => setError((e as Error).message));
  };

  // Managed roles are reconciled from the chart's declarative RBAC policy and are
  // read-only via the API. Gate every edit control on !role.managed so an admin
  // never sees a button that would only return a 409; the backend still enforces
  // this regardless of the UI.
  const editable = !!me.admin && !role.managed;

  return (
    <>
      <div className="page-head">
        <h1>{role.name}</h1>
        <Link className="btn secondary" to="/roles">Back to roles</Link>
      </div>
      {role.description && <p className="page-desc">{role.description}</p>}
      {role.managed && (
        <div className="panel" style={{ borderColor: "var(--accent)" }}>
          <h2 style={{ marginTop: 0, display: "flex", alignItems: "center", gap: 8 }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
              style={{ color: "var(--accent)" }}>
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
            Managed role
          </h2>
          <p className="muted" style={{ margin: 0 }}>
            This role was configured by a Forklift administrator in the declarative RBAC policy so it cannot be edited here. To change its permissions or delete it ask an administrator to update the policy file and restart forklift.
          </p>
        </div>
      )}
      {error && <div className="error">{error}</div>}

      <PermissionsPanel role={role} run={run} canWrite={editable} />
      <AssignedUsersPanel members={members} />
      {editable && <DangerPanel role={role} onDeleted={() => navigate("/roles")} onError={setError} />}
    </>
  );
}

// AssignedUsersPanel lists the users that currently hold this role. Assignment
// itself is managed on each user's Modify page, so this is read-only with links.
function AssignedUsersPanel({ members }: { members: User[] }) {
  return (
    <div className="panel">
      <h2 style={{ marginTop: 0 }}>
        Assigned users <span className="badge" style={{ marginLeft: 6 }}>{members.length}</span>
      </h2>
      {members.length === 0
        ? <p className="muted">No users have this role. Assign it from a user's Modify page.</p>
        : (
          // Same column structure and order as the Users page.
          <table>
            <thead>
              <tr><th>Username</th><th>Source</th><th>Email</th><th>Roles</th><th>Status</th><th>Last login</th><th></th></tr>
            </thead>
            <tbody>
              {members.map((u) => (
                <tr key={u.id}>
                  <td style={{ whiteSpace: "nowrap" }}>{u.username}</td>
                  <td><span className="badge">{u.source}</span></td>
                  <td className="muted">{u.email || "-"}</td>
                  <td>
                    <div className="inline" style={{ flexWrap: "wrap", gap: 6 }}>
                      {u.roles.map((r) => <Link key={r.id} className="badge" to={`/roles/${r.id}`}>{r.name}</Link>)}
                      {u.roles.length === 0 && <span className="muted">none</span>}
                    </div>
                  </td>
                  <td>
                    {u.disabled
                      ? <span className="status"><span className="dot bad" /> disabled</span>
                      : <span className="status"><span className="dot ok" /> active</span>}
                  </td>
                  <td className="muted" style={{ whiteSpace: "nowrap" }} title={u.last_login_at ?? undefined}>
                    {u.last_login_at ? new Date(u.last_login_at).toLocaleString() : "never"}
                  </td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    <Link className="btn secondary" to={`/users/${u.id}`}>Modify</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
    </div>
  );
}

function PermissionsPanel({ role, run, canWrite }: { role: Role; run: (p: Promise<unknown>) => void; canWrite: boolean }) {
  const [pattern, setPattern] = useState("");
  const [actions, setActions] = useState<string[]>(["read"]);
  const [repoOptions, setRepoOptions] = useState<string[]>(["*"]);
  const [repoTypes, setRepoTypes] = useState<Record<string, string>>({});

  useEffect(() => {
    api.listRepositoryNames()
      .then((repos) => {
        setRepoOptions(["*", ...repos.map((r) => r.name)]);
        setRepoTypes(Object.fromEntries(repos.map((r) => [r.name, `${r.format} · ${r.type}`])));
      })
      .catch(() => setRepoOptions(["*"]));
  }, []);

  const toggle = (a: string) =>
    setActions((cur) => cur.includes(a) ? cur.filter((x) => x !== a) : [...cur, a]);

  const add = () => {
    run(api.addPermission(role.id, { repo_pattern: pattern.trim(), actions }));
    setPattern("");
    setActions(["read"]);
  };

  return (
    <div className="panel">
      <h2 style={{ marginTop: 0 }}>Permissions</h2>
      <div className="inline" style={{ flexWrap: "wrap", gap: 6 }}>
        {role.permissions.map((p) => (
          <span key={p.id} className="badge" style={{ fontFamily: "ui-monospace, monospace" }}>
            {p.repo_pattern}: {p.actions.join(",")}
            {canWrite && (
              <a style={{ marginLeft: 6, cursor: "pointer" }} title="Remove permission"
                onClick={() => run(api.deletePermission(role.id, p.id))}>×</a>
            )}
          </span>
        ))}
        {role.permissions.length === 0 && <span className="muted">No permissions granted.</span>}
      </div>
      {canWrite && (
        <div className="inline" style={{ marginTop: 12, flexWrap: "wrap", gap: 8 }}>
          <Combobox style={{ width: 200 }} value={pattern} onChange={setPattern}
            options={repoOptions} hints={repoTypes} placeholder="repo pattern (* or maven-*)" />
          {ACTIONS.map((a) => (
            <label key={a} className="checkbox" style={{ margin: 0, fontSize: 12 }}>
              <input type="checkbox" checked={actions.includes(a)} onChange={() => toggle(a)} />
              <span>{a}</span>
            </label>
          ))}
          <button className="btn secondary" type="button"
            disabled={!pattern.trim() || actions.length === 0} onClick={add}>Add</button>
        </div>
      )}
    </div>
  );
}

function DangerPanel({ role, onDeleted, onError }: {
  role: Role; onDeleted: () => void; onError: (e: string) => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const del = async () => {
    try {
      await api.deleteRole(role.id);
      onDeleted();
    } catch (e) {
      onError((e as Error).message);
    }
  };
  return (
    <div className="panel danger" style={{ marginTop: 18 }}>
      <h2 style={{ marginTop: 0 }}>Danger zone</h2>
      <p className="muted">Users and group mappings holding this role lose its permissions immediately. This cannot be undone.</p>
      <button className="btn danger" type="button" onClick={() => setConfirm(true)}>Delete role</button>
      <ConfirmModal
        open={confirm}
        title={`Delete role "${role.name}"?`}
        message="Users and group mappings holding this role lose its permissions immediately."
        confirmLabel="Delete"
        danger
        onConfirm={() => { setConfirm(false); del(); }}
        onCancel={() => setConfirm(false)}
      />
    </div>
  );
}
