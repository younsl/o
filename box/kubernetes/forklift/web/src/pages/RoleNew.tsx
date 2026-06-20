import { FormEvent, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { Combobox } from "../components/Combobox";

const ACTIONS = ["read", "write", "delete", "approve", "admin"];

interface Permission {
  repo_pattern: string;
  actions: string[];
}

// Admin-only role creation, reached from the Create button on /roles.
// Permissions can be granted here at creation, or added later on the Roles page.
export function RoleNew() {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [error, setError] = useState("");

  // Permission add-row state.
  const [pattern, setPattern] = useState("");
  const [actions, setActions] = useState<string[]>(["read"]);

  // Repository names for pattern autocomplete; "*" (all) is offered first.
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

  const addPermission = () => {
    if (!pattern.trim() || actions.length === 0) return;
    setPermissions((cur) => [...cur, { repo_pattern: pattern.trim(), actions: [...actions] }]);
    setPattern("");
    setActions(["read"]);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      await api.createRole({
        name,
        description: description || undefined,
        permissions: permissions.length ? permissions : undefined,
      });
      navigate("/roles");
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <>
      <h1>Create role</h1>
      <form className="panel" onSubmit={submit} style={{ maxWidth: 560 }}>
        <label>Role name<span className="req">*</span></label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="maven-readers" autoFocus required
          pattern="[A-Za-z0-9_-]{1,64}" title="Letters, digits, '-' and '_' only (max 64 characters)" />

        <label>Description</label>
        <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="optional" />

        <label>Permissions</label>
        <div className="inline" style={{ flexWrap: "wrap", gap: 6 }}>
          {permissions.map((p, i) => (
            <span key={i} className="badge" style={{ fontFamily: "ui-monospace, monospace" }}>
              {p.repo_pattern}: {p.actions.join(",")}
              <a style={{ marginLeft: 6, cursor: "pointer" }} title="Remove permission"
                onClick={() => setPermissions((cur) => cur.filter((_, j) => j !== i))}>×</a>
            </span>
          ))}
          {permissions.length === 0 && <span className="muted">none yet (optional)</span>}
        </div>
        <div className="inline" style={{ marginTop: 8, flexWrap: "wrap", gap: 8 }}>
          <Combobox style={{ width: 200 }} value={pattern} onChange={setPattern}
            options={repoOptions} hints={repoTypes} placeholder="repo pattern (* or maven-*)" />
          {ACTIONS.map((a) => (
            <label key={a} className="checkbox" style={{ margin: 0, fontSize: 12 }}>
              <input type="checkbox" checked={actions.includes(a)} onChange={() => toggle(a)} />
              <span>{a}</span>
            </label>
          ))}
          <button className="btn secondary" type="button" onClick={addPermission}
            disabled={!pattern.trim() || actions.length === 0}>Add</button>
        </div>
        <p className="muted">Permissions are optional here and can also be granted on the Roles page later. Assign the role to users on the Users page.</p>

        {error && <div className="error">{error}</div>}
        <div style={{ marginTop: 18 }} className="inline">
          <button className="btn" type="submit" disabled={!name.trim()}>Create</button>
          <button className="btn secondary" type="button" onClick={() => navigate("/roles")}>Cancel</button>
        </div>
      </form>
    </>
  );
}
