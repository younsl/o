import { FormEvent, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { Combobox } from "../components/Combobox";

const ACTIONS = ["read", "write", "delete"];
const MAX_TTL_HOURS = 365 * 24;

interface Scope {
  repo_pattern: string;
  actions: string[];
}

function dateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Token creation page, reached from the New token button on /tokens. All
// fields are required; expiry is capped at one year by the API.
export function TokenNew() {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [scopes, setScopes] = useState<Scope[]>([]);
  const [expiresOn, setExpiresOn] = useState("");
  const [error, setError] = useState("");
  const [created, setCreated] = useState("");
  const [copied, setCopied] = useState(false);

  // Scope add-row state.
  const [pattern, setPattern] = useState("");
  const [actions, setActions] = useState<string[]>(["read"]);

  // Repository names for scope-pattern autocomplete. Available to any
  // authenticated user; "*" (all repositories) is offered as the first option.
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

  const today = new Date();
  const minDate = new Date(today.getTime() + 24 * 3600 * 1000);
  const maxDate = new Date(today.getTime() + MAX_TTL_HOURS * 3600 * 1000);

  const toggle = (a: string) =>
    setActions((cur) => cur.includes(a) ? cur.filter((x) => x !== a) : [...cur, a]);

  const addScope = () => {
    if (!pattern.trim() || actions.length === 0) return;
    setScopes((cur) => [...cur, { repo_pattern: pattern.trim(), actions: [...actions] }]);
    setPattern("");
    setActions(["read"]);
  };

  const expiresIn = (): string => {
    const target = new Date(expiresOn + "T00:00:00");
    const hours = Math.ceil((target.getTime() - Date.now()) / 3600000);
    return `${Math.min(Math.max(hours, 1), MAX_TTL_HOURS)}h`;
  };

  const valid = name.trim() && description.trim() && scopes.length > 0 && expiresOn;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      const res = await api.createToken({
        name: name.trim(),
        description: description.trim(),
        scopes,
        expires_in: expiresIn(),
      });
      setCreated(res.token);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const copy = () => {
    navigator.clipboard?.writeText(created);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (created) {
    return (
      <>
        <h1>Token created</h1>
        <div className="panel" style={{ maxWidth: 640 }}>
          <div className="muted">Copy this token now; it will not be shown again.</div>
          <div className="inline" style={{ marginTop: 10 }}>
            <div className="token-value" style={{ flex: 1 }}>{created}</div>
            <button className="btn secondary" type="button" onClick={copy}>
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <div style={{ marginTop: 18 }}>
            <button className="btn" onClick={() => navigate("/tokens")}>Done</button>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <h1>Create token</h1>
      <form className="panel" onSubmit={submit} style={{ maxWidth: 640 }}>
        <label>Token name<span className="req">*</span></label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="ci" autoFocus required
          pattern="[A-Za-z0-9_-]{1,64}" title="Letters, digits, '-' and '_' only (max 64 characters)" />

        <label>Token description<span className="req">*</span></label>
        <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this token is used for" required />

        <label>Permissions<span className="req">*</span></label>
        <div className="inline" style={{ flexWrap: "wrap", gap: 6 }}>
          {scopes.map((s, i) => (
            <span key={i} className="badge" style={{ fontFamily: "ui-monospace, monospace" }}>
              {s.repo_pattern}: {s.actions.join(",")}
              <a style={{ marginLeft: 6, cursor: "pointer" }} title="Remove permission"
                onClick={() => setScopes((cur) => cur.filter((_, j) => j !== i))}>×</a>
            </span>
          ))}
          {scopes.length === 0 && <span className="muted">none yet — add at least one</span>}
        </div>
        <div className="inline" style={{ marginTop: 8, flexWrap: "wrap", gap: 8 }}>
          <Combobox style={{ width: 220 }} value={pattern} onChange={setPattern}
            options={repoOptions} hints={repoTypes} placeholder="repo pattern (* or maven-*)" />
          {ACTIONS.map((a) => (
            <label key={a} className="checkbox" style={{ margin: 0, fontSize: 12 }}>
              <input type="checkbox" checked={actions.includes(a)} onChange={() => toggle(a)} />
              <span>{a}</span>
            </label>
          ))}
          <button className="btn secondary" type="button" onClick={addScope}
            disabled={!pattern.trim() || actions.length === 0}>Add</button>
        </div>

        <label style={{ marginTop: 14 }}>Expires on<span className="req">*</span></label>
        <input type="date" value={expiresOn} min={dateStr(minDate)} max={dateStr(maxDate)}
          onChange={(e) => setExpiresOn(e.target.value)} required />
        <p className="muted">Tokens expire after at most one year.</p>

        {error && <div className="error">{error}</div>}
        <div style={{ marginTop: 18 }} className="inline">
          <button className="btn" type="submit" disabled={!valid}>Create</button>
          <button className="btn secondary" type="button" onClick={() => navigate("/tokens")}>Cancel</button>
        </div>
      </form>
    </>
  );
}
