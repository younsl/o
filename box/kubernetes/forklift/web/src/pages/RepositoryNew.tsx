import { FormEvent, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, Repository, UpstreamHealth } from "../api";
import { Select } from "../components/Select";

const REPO_TYPES = [
  { value: "hosted", title: "Hosted", desc: "Store artifacts uploaded directly by your team" },
  { value: "proxy", title: "Proxy", desc: "Cache and serve artifacts from an upstream registry" },
  { value: "group", title: "Group", desc: "Combine repositories behind a single read-only URL" },
];

export function RepositoryNew() {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [format, setFormat] = useState("maven");
  const [type, setType] = useState("proxy");
  const [upstream, setUpstream] = useState("");
  const [ageEnabled, setAgeEnabled] = useState(false);
  const [minAge, setMinAge] = useState("3d");
  const [members, setMembers] = useState<string[]>([]);
  const [repos, setRepos] = useState<Repository[]>([]);
  const [error, setError] = useState("");
  // Auto connectivity check for the upstream URL (proxy only), debounced.
  const [health, setHealth] = useState<UpstreamHealth | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    api.listRepositories().then(setRepos).catch(() => setRepos([]));
  }, []);

  // Probe the upstream URL ~600ms after the user stops typing. The cancelled
  // flag drops stale responses so only the latest URL's result is shown.
  useEffect(() => {
    const url = upstream.trim();
    if (type !== "proxy" || url === "") {
      setHealth(null);
      setChecking(false);
      return;
    }
    let cancelled = false;
    setChecking(true);
    const t = setTimeout(() => {
      api.checkUpstream(url)
        .then((h) => { if (!cancelled) { setHealth(h); setChecking(false); } })
        .catch(() => { if (!cancelled) { setHealth(null); setChecking(false); } });
    }, 600);
    return () => { cancelled = true; clearTimeout(t); };
  }, [upstream, type]);

  // Candidate members: same format, not a group itself, not yet selected.
  const candidates = repos.filter(
    (r) => r.format === format && r.type !== "group" && !members.includes(r.name),
  );

  // Mirrors the form's required fields so Create stays disabled until complete.
  const valid =
    name.trim() !== "" &&
    (type !== "proxy" || upstream.trim() !== "") &&
    (type !== "proxy" || !ageEnabled || minAge.trim() !== "") &&
    (type !== "group" || members.length > 0);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      await api.createRepository({
        name,
        format,
        type,
        upstream_url: type === "proxy" ? upstream : "",
        config: {
          cache: { enabled: true, metadata_ttl: "15m", negative_ttl: "5m", eviction: "lru" },
          age_policy: ageEnabled
            ? { enabled: true, min_age: minAge, action: "block" }
            : { enabled: false },
          ...(type === "group" ? { group: { members } } : {}),
        },
      });
      navigate("/repositories");
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <>
      <h1>New repository</h1>
      <form className="panel" onSubmit={submit} style={{ maxWidth: 560 }}>
        <label>Name<span className="req">*</span></label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="maven-central" required
          pattern="[A-Za-z0-9_-]{1,64}" title="Letters, digits, '-' and '_' only (max 64 characters)" />
        <label>Format<span className="req">*</span></label>
        <Select value={format} onChange={(v) => { setFormat(v); setMembers([]); }}
          options={[
            { value: "maven", label: "Maven / Gradle" },
            { value: "npm", label: "npm" },
            { value: "cargo", label: "Cargo" },
            { value: "go", label: "Go Modules" },
            { value: "pypi", label: "PyPI" },
          ]} />
        <label>Type<span className="req">*</span></label>
        <div className="type-cards" role="radiogroup" aria-label="Repository type">
          {REPO_TYPES.map((t) => (
            <button
              key={t.value}
              type="button"
              role="radio"
              aria-checked={type === t.value}
              className={`type-card${type === t.value ? " selected" : ""}`}
              onClick={() => setType(t.value)}
            >
              <div className="type-title">{t.title}</div>
              <div className="type-desc">{t.desc}</div>
            </button>
          ))}
        </div>
        {type === "proxy" && (
          <>
            <label>Upstream URL<span className="req">*</span></label>
            <input value={upstream} onChange={(e) => setUpstream(e.target.value)}
              placeholder="https://repo1.maven.org/maven2" required />
            <ConnectivityHint checking={checking} health={health} hasUrl={upstream.trim() !== ""} />
          </>
        )}
        {type === "group" && (
          <>
            <label>Members (lookup order, first hit wins)<span className="req">*</span></label>
            <MemberList members={members} onChange={setMembers}
              repoIndex={Object.fromEntries(repos.map((r) => [r.name, r.id]))} />
            <div className="inline" style={{ marginTop: 8 }}>
              <Select value="" placeholder="add member…"
                onChange={(v) => v && setMembers([...members, v])}
                options={candidates.map((r) => ({ value: r.name, label: `${r.name} (${r.type})` }))} />
            </div>
            {candidates.length === 0 && members.length === 0 && (
              <p className="muted">No {format} repositories exist yet. Create the members first.</p>
            )}
          </>
        )}
        {type === "proxy" && (
          <>
            <h2>Age policy (supply-chain cooldown)</h2>
            <div className="checkbox">
              <input type="checkbox" checked={ageEnabled} onChange={(e) => setAgeEnabled(e.target.checked)} />
              <span>Block versions newer than a cooldown window</span>
            </div>
            {ageEnabled && (
              <>
                <label>Minimum age (e.g. 3d, 72h)<span className="req">*</span></label>
                <input value={minAge} onChange={(e) => setMinAge(e.target.value)} required />
              </>
            )}
          </>
        )}
        {error && <div className="error">{error}</div>}
        <div style={{ marginTop: 18 }} className="inline">
          <button className="btn" type="submit" disabled={!valid}>Create</button>
          <button className="btn secondary" type="button" onClick={() => navigate("/repositories")}>Cancel</button>
        </div>
      </form>
    </>
  );
}

// ConnectivityHint renders the live result of the debounced upstream probe
// under the URL field: a spinner-ish "checking" line, then reachable/unreachable.
function ConnectivityHint({ checking, health, hasUrl }: {
  checking: boolean; health: UpstreamHealth | null; hasUrl: boolean;
}) {
  if (!hasUrl) return null;
  if (checking) {
    return <p className="muted" style={{ marginTop: 6, fontSize: 13 }}>Checking connectivity…</p>;
  }
  if (!health) return null;
  if (health.reachable) {
    return (
      <p style={{ marginTop: 6, fontSize: 13, color: "var(--ok, #2e7d32)" }}>
        ✓ Reachable — HTTP {health.status}{health.latency_ms != null && ` (${health.latency_ms} ms)`}
      </p>
    );
  }
  return (
    <p style={{ marginTop: 6, fontSize: 13, color: "var(--danger, #c0392b)" }}>
      ✗ Unreachable{health.error ? ` — ${health.error}` : ""}
    </p>
  );
}

// MemberList renders an ordered member list with reorder and remove controls.
// Shared by the create form and the settings tab. When repoIndex maps a member
// name to a repository id, the name links to that repository's page.
export function MemberList({ members, onChange, repoIndex }: {
  members: string[];
  onChange: (m: string[]) => void;
  repoIndex?: Record<string, number>;
}) {
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= members.length) return;
    const next = [...members];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  if (members.length === 0) return <p className="muted">No members selected.</p>;
  return (
    <table>
      <tbody>
        {members.map((name, i) => {
          const id = repoIndex?.[name];
          return (
          <tr key={name}>
            <td className="muted" style={{ width: 24 }}>{i + 1}</td>
            <td style={{ fontFamily: "ui-monospace, monospace", fontSize: 13 }}>
              {id !== undefined
                ? <Link to={`/repositories/${id}`}>{name}</Link>
                : name}
            </td>
            <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
              <button className="btn secondary" type="button" disabled={i === 0}
                title="Move up" onClick={() => move(i, -1)}>↑</button>{" "}
              <button className="btn secondary" type="button" disabled={i === members.length - 1}
                title="Move down" onClick={() => move(i, 1)}>↓</button>{" "}
              <button className="btn danger" type="button" title="Remove member"
                onClick={() => onChange(members.filter((m) => m !== name))}>×</button>
            </td>
          </tr>
          );
        })}
      </tbody>
    </table>
  );
}
