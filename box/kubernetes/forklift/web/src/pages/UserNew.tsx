import { FormEvent, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, Role } from "../api";
import { Select } from "../components/Select";

// Admin-only local user creation, reached from the Create button on /users.
// OIDC users are never created here; they appear at first SSO login.
export function UserNew() {
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [email, setEmail] = useState("");
  const [roleId, setRoleId] = useState("");
  const [roles, setRoles] = useState<Role[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    api.listRoles().then(setRoles).catch(() => setRoles([]));
  }, []);

  const mismatch = confirm.length > 0 && password !== confirm;
  const canSubmit = username.trim() && password && password === confirm;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    try {
      await api.createUser({
        username, password, email: email || undefined,
        role_ids: roleId ? [Number(roleId)] : undefined,
      });
      navigate("/users");
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <>
      <h1>Create local user</h1>
      <form className="panel" onSubmit={submit} style={{ maxWidth: 560 }}>
        <label>Username<span className="req">*</span></label>
        <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus required
          pattern="[A-Za-z0-9_-]{1,64}" title="Letters, digits, '-' and '_' only (max 64 characters)" />

        <label>Password<span className="req">*</span></label>
        <div className="password-field">
          <input type={show ? "text" : "password"} value={password}
            onChange={(e) => setPassword(e.target.value)} required />
          <button type="button" className="password-toggle"
            onClick={() => setShow((s) => !s)}
            aria-label={show ? "Hide password" : "Show password"}>
            {show ? "Hide" : "Show"}
          </button>
        </div>

        <label>Confirm password<span className="req">*</span></label>
        <div className="password-field">
          <input type={show ? "text" : "password"} value={confirm}
            onChange={(e) => setConfirm(e.target.value)} required
            aria-invalid={mismatch} />
          <button type="button" className="password-toggle"
            onClick={() => setShow((s) => !s)}
            aria-label={show ? "Hide password" : "Show password"}>
            {show ? "Hide" : "Show"}
          </button>
        </div>
        {mismatch && <div className="error" style={{ marginTop: 8 }}>Passwords do not match.</div>}

        <label>Role</label>
        <Select value={roleId} onChange={setRoleId} placeholder="no role"
          options={roles.map((r) => ({ value: String(r.id), label: r.name, description: r.description || undefined }))} />
        <p className="muted">A local user with no role cannot access any repository until one is assigned.</p>

        <label>Email</label>
        <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="optional" />
        <p className="muted">OIDC users are created automatically at first login; their access comes from group mappings.</p>
        {error && <div className="error">{error}</div>}
        <div style={{ marginTop: 18 }} className="inline">
          <button className="btn" type="submit" disabled={!canSubmit}>Create</button>
          <button className="btn secondary" type="button" onClick={() => navigate("/users")}>Cancel</button>
        </div>
      </form>
    </>
  );
}
