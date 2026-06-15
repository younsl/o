import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, humanSize, repoEndpoint, Repository } from "../api";
import { UpstreamStatus } from "../components/UpstreamStatus";

// ArtifactCount shows the number of stored artifacts; empty repos (and group
// repos, which store nothing themselves) render a muted 0.
function ArtifactCount({ repo }: { repo: Repository }) {
  const count = repo.artifact_count ?? 0;
  return <span className={count === 0 ? "muted" : undefined}>{count.toLocaleString()}</span>;
}

// RepoSize shows stored bytes, human-readable (B/KB/MB/GB/TB); proxies with a
// cache size cap also show usage against the cap. Empty repos render a muted 0 B.
function RepoSize({ repo }: { repo: Repository }) {
  const size = repo.total_size ?? 0;
  const max = repo.config.cache.max_size_bytes;
  return (
    <span className={size === 0 ? "muted" : undefined}>
      {humanSize(size)}
      {repo.type === "proxy" && max > 0 && <span className="muted"> / {humanSize(max)}</span>}
    </span>
  );
}

// SecurityIcons renders the supply-chain policy state for a proxy repo: a clock
// (age policy) and a shield (package approval), each lit when enabled and
// carrying a concise tooltip. Non-proxy repos have no upstream to gate.
function SecurityIcons({ repo }: { repo: Repository }) {
  if (repo.type !== "proxy") return <span className="muted">—</span>;
  const age = repo.config.age_policy;
  const approval = repo.config.approval ?? { enabled: false, mode: "enforce" };
  const minAge = age.min_age || "0";
  const ageTip = !age.enabled
    ? "Age policy is disabled."
    : age.action === "warn"
      ? `Age policy warns about versions published less than ${minAge} ago.`
      : `Age policy blocks versions published less than ${minAge} ago.`;
  const approvalTip = !approval.enabled
    ? "Package approval is disabled."
    : approval.mode === "audit"
      ? "Package approval is in audit mode. Requests are logged but packages are still served."
      : "Package approval is on. An admin must approve a package before this proxy serves it.";
  return (
    <span className="sec-icons">
      <span className={`sec-icon tooltip${age.enabled ? " on" : ""}`}
        data-tooltip={ageTip} role="img" aria-label={ageTip} tabIndex={0}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
        </svg>
      </span>
      <span className={`sec-icon tooltip${approval.enabled ? " on" : ""}`}
        data-tooltip={approvalTip} role="img" aria-label={approvalTip} tabIndex={0}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3l7 3v6c0 4-3 7-7 8-4-1-7-4-7-8V6z" /><path d="M9 12l2 2 4-4" />
        </svg>
      </span>
    </span>
  );
}

export function Repositories() {
  const [repos, setRepos] = useState<Repository[]>([]);
  const [error, setError] = useState("");

  const load = () => api.listRepositories().then(setRepos).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  return (
    <>
      <div className="page-head">
        <h1>Repositories</h1>
        <Link className="btn" to="/repositories/new">New repository</Link>
      </div>
      <p className="page-desc">
        Host and proxy artifacts across Maven, npm, Cargo, Go, and PyPI. Configure
        per-repository caching and supply-chain policies (age cooldown, package approval).
      </p>
      {error && <div className="error">{error}</div>}
      <div className="panel">
        <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Name</th><th>Format</th><th>Type</th><th>Endpoint (forklift)</th><th>Artifacts</th><th>Size</th><th>Upstream</th><th>Security</th></tr>
          </thead>
          <tbody>
            {repos.map((r) => (
              <tr key={r.id}>
                <td><Link to={`/repositories/${r.id}`}>{r.name}</Link></td>
                <td>{r.format}</td>
                <td><span className={`badge ${r.type}`}>{r.type}</span></td>
                <td style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }}>
                  {repoEndpoint(r.format, r.name).url}
                  {r.type === "proxy" && !r.config.cache.enabled && <span className="muted"> (cache off)</span>}
                </td>
                <td style={{ whiteSpace: "nowrap" }}><ArtifactCount repo={r} /></td>
                <td style={{ whiteSpace: "nowrap" }}><RepoSize repo={r} /></td>
                <td>{r.type === "proxy" ? <UpstreamStatus repoId={r.id} compact /> : <span className="muted">—</span>}</td>
                <td><SecurityIcons repo={r} /></td>
              </tr>
            ))}
            {repos.length === 0 && (
              <tr><td colSpan={8} className="muted">No repositories yet.</td></tr>
            )}
          </tbody>
        </table>
        </div>
      </div>
    </>
  );
}
