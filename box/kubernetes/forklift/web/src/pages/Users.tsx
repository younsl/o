import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, Me, User } from "../api";

// Admin user directory (read-only). All edits (role mapping, password reset,
// enable/disable, delete) happen on each user's Modify page; creation and its
// initial role assignment happen on /users/new.
export function Users({ me }: { me: Me }) {
  const [users, setUsers] = useState<User[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    api.listUsers().then(setUsers).catch((e) => setError(e.message));
  }, []);

  return (
    <>
      <div className="page-head">
        <h1>Users</h1>
        {me.admin && <Link className="btn" to="/users/new">Create user</Link>}
      </div>
      <p className="page-desc">
        Local and OIDC accounts. Open a user to map roles, reset the password, or disable access.
        OIDC users appear automatically at first login.
      </p>
      {error && <div className="error">{error}</div>}

      <div className="panel">
        <h2>Users</h2>
        <table>
          <thead>
            <tr><th>Username</th><th>Source</th><th>Email</th><th>Roles</th><th>Status</th><th>Last login</th><th></th></tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td style={{ whiteSpace: "nowrap" }}>
                  {u.username}
                  {u.username === me.username && <span className="badge" style={{ marginLeft: 8 }}>you</span>}
                </td>
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
            {users.length === 0 && <tr><td colSpan={7} className="muted">No users.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
