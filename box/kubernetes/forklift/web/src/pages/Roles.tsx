import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, Me, Role } from "../api";

// Admin role directory (read-only). Roles and their permissions are defined on
// /roles/new; this page only displays them.
export function Roles({ me }: { me: Me }) {
  const [roles, setRoles] = useState<Role[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    api.listRoles().then(setRoles).catch((e) => setError(e.message));
  }, []);

  return (
    <>
      <div className="page-head">
        <h1>Roles</h1>
        {me.admin && <Link className="btn" to="/roles/new">Create role</Link>}
      </div>
      <p className="page-desc">
        Bundle repository permissions (read, write, delete, approve, audit, admin) over name patterns.
        Open a role to map permissions; roles are assigned to users on each user's Modify page.
      </p>
      {error && <div className="error">{error}</div>}

      <div className="panel">
        <table>
          <thead>
            <tr><th>Role</th><th>Source</th><th>Description</th><th>Users</th><th>Permissions</th><th></th></tr>
          </thead>
          <tbody>
            {roles.map((r) => (
              <tr key={r.id}>
                <td>{r.name}</td>
                <td>
                  <span className="badge" title={r.managed
                    ? "Managed by the declarative RBAC policy and not editable in the UI."
                    : "Created in the UI or API and editable here."}>
                    {r.managed ? "managed" : "local"}
                  </span>
                </td>
                <td className="muted">{r.description || "-"}</td>
                <td>{r.user_count}</td>
                <td>
                  <div className="inline" style={{ flexWrap: "wrap", gap: 6 }}>
                    {r.permissions.map((p) => (
                      <span key={p.id} className="badge" style={{ fontFamily: "ui-monospace, monospace" }}>
                        {p.repo_pattern}: {p.actions.join(",")}
                      </span>
                    ))}
                    {r.permissions.length === 0 && <span className="muted">none</span>}
                  </div>
                </td>
                <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                  <Link className="btn secondary" to={`/roles/${r.id}`}>Modify</Link>
                </td>
              </tr>
            ))}
            {roles.length === 0 && <tr><td colSpan={6} className="muted">No roles yet. Create one to grant repository access.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
