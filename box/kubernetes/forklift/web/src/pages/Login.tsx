import { FormEvent, useEffect, useState } from "react";
import { api } from "../api";
import { Logo } from "../components/Logo";

export function Login({ onLogin }: { onLogin: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // Only offer Keycloak when OIDC is configured; otherwise /auth/login 404s.
  const [oidcEnabled, setOidcEnabled] = useState(false);

  useEffect(() => {
    api.version().then((v) => setOidcEnabled(v.oidc_enabled)).catch(() => setOidcEnabled(false));
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await api.login(username, password);
      onLogin();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="panel login-card" onSubmit={submit}>
        <div className="brand" style={{ padding: "0 0 16px" }}><Logo /><span className="brand-text">fork<span>lift</span></span></div>
        <label>Username<span className="req">*</span></label>
        <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus required />
        <label>Password<span className="req">*</span></label>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        {error && <div className="error">{error}</div>}
        <div style={{ marginTop: 16 }}>
          <button className="btn" disabled={busy} style={{ width: "100%" }}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </div>
        {oidcEnabled && (
          <div style={{ marginTop: 12 }}>
            <a className="btn secondary" href="/auth/login" style={{ display: "block", width: "100%", textAlign: "center", boxSizing: "border-box", padding: "10px 14px" }}>
              Sign in with Keycloak
            </a>
          </div>
        )}
      </form>
    </div>
  );
}
