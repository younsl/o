import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, Token } from "../api";
import { ConfirmModal } from "../components/ConfirmModal";

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

export function Tokens() {
  const [tokens, setTokens] = useState<Token[]>([]);
  const [error, setError] = useState("");
  const [revokeId, setRevokeId] = useState<number | null>(null);

  const load = () => api.listTokens().then(setTokens).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const revoke = async () => {
    if (revokeId === null) return;
    await api.deleteToken(revokeId);
    setRevokeId(null);
    load();
  };

  return (
    <>
      <div className="page-head">
        <h1>Personal access tokens</h1>
        <Link className="btn" to="/tokens/new">New token</Link>
      </div>
      <p className="page-desc">
        Scoped credentials for package clients, limited to chosen repositories and actions
        within your own permissions. Use a token as the password in your package manager
        (npm <code>_authToken</code>, Maven, Cargo, <code>.netrc</code> for Go).
      </p>

      {error && <div className="error">{error}</div>}

      <div className="panel">
        <table>
          <thead><tr><th>Name</th><th>Description</th><th>Permissions</th><th>Created</th><th>Expires</th><th>Last used</th><th></th></tr></thead>
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
                <td><button className="btn danger" onClick={() => setRevokeId(t.id)}>Revoke</button></td>
              </tr>
            ))}
            {tokens.length === 0 && <tr><td colSpan={7} className="muted">No tokens yet.</td></tr>}
          </tbody>
        </table>
      </div>

      <ConfirmModal
        open={revokeId !== null}
        title="Revoke this token?"
        message="Clients using this token will immediately lose access. This cannot be undone."
        confirmLabel="Revoke"
        danger
        onConfirm={revoke}
        onCancel={() => setRevokeId(null)}
      />
    </>
  );
}
