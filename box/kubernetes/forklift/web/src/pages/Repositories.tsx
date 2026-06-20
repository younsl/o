import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, humanSize, Me, repoEndpoint, Repository } from "../api";
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

// repoCells renders the columns after Name, shared by top-level and nested
// (group member) rows so a member shows its own format/type/endpoint/status.
function repoCells(r: Repository, isAdmin: boolean) {
  return (
    <>
      <td>{r.format}</td>
      <td>{r.type}</td>
      <td style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }} title={repoEndpoint(r.format, r.name).url}>
        {repoEndpoint(r.format, r.name).url}
        {r.type === "proxy" && !r.config.cache.enabled && <span className="muted"> (cache off)</span>}
      </td>
      <td style={{ whiteSpace: "nowrap" }}><ArtifactCount repo={r} /></td>
      <td style={{ whiteSpace: "nowrap" }}><RepoSize repo={r} /></td>
      {/* Remote-health and supply-chain policy state are admin-only (Nexus parity). */}
      <td>{isAdmin && r.type === "proxy" ? <UpstreamStatus repoId={r.id} compact /> : <span className="muted">—</span>}</td>
      <td>{isAdmin ? <SecurityIcons repo={r} /> : <span className="muted">—</span>}</td>
    </>
  );
}

export function Repositories({ me }: { me: Me }) {
  const [repos, setRepos] = useState<Repository[]>([]);
  const [error, setError] = useState("");
  // Detail is read-only browsable by any authenticated user, so every name links
  // into it; admin-only controls are hidden inside the detail page itself.
  const nameNode = (id: number, name: string) => <Link to={`/repositories/${id}`}>{name}</Link>;
  // Groups are expanded by default so the composition tree is visible at a glance.
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const load = () =>
    api.listRepositories()
      .then((rs) => {
        setRepos(rs);
        setExpanded(new Set(rs.filter((r) => r.type === "group").map((r) => r.id)));
      })
      .catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const byName = Object.fromEntries(repos.map((r) => [r.name, r]));
  // Names that belong to at least one group are shown only nested under their
  // group(s), never as a duplicate top-level row.
  const memberNames = new Set(
    repos.flatMap((r) => (r.type === "group" ? r.config.group?.members ?? [] : [])),
  );
  const topLevel = repos.filter((r) => !memberNames.has(r.name));
  const toggle = (id: number) =>
    setExpanded((s) => {
      const next = new Set(s);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  return (
    <>
      <div className="page-head">
        <h1>Repositories</h1>
        {me.admin && <Link className="btn" to="/repositories/new">New repository</Link>}
      </div>
      <p className="page-desc">
        Host and proxy artifacts across Maven, npm, Cargo, Go, and PyPI. Configure
        per-repository caching and supply-chain policies (age cooldown, package approval).
      </p>
      {error && <div className="error">{error}</div>}
      <div className="panel">
        <table className="repo-table">
          <colgroup>
            <col style={{ width: "16%" }} />
            <col style={{ width: "8%" }} />
            <col style={{ width: "8%" }} />
            <col style={{ width: "31%" }} />
            <col style={{ width: "9%" }} />
            <col style={{ width: "8%" }} />
            <col style={{ width: "11%" }} />
            <col style={{ width: "9%" }} />
          </colgroup>
          <thead>
            <tr><th>Name</th><th>Format</th><th>Type</th><th>Endpoint (forklift)</th><th>Artifacts</th><th>Size</th><th>Upstream</th><th>Security</th></tr>
          </thead>
          <tbody>
            {topLevel.flatMap((r) => {
              const isGroup = r.type === "group";
              const members = r.config.group?.members ?? [];
              const open = expanded.has(r.id);
              const rows = [
                <tr key={`r-${r.id}`}>
                  <td>
                    {isGroup ? (
                      <span className="inline" style={{ gap: 4, alignItems: "center" }}>
                        <button type="button" className="tree-caret" aria-expanded={open}
                          aria-label={open ? "Collapse group" : "Expand group"} onClick={() => toggle(r.id)}>
                          {open ? "▾" : "▸"}
                        </button>
                        {nameNode(r.id, r.name)}
                        <span className="muted" style={{ fontSize: 12 }}>({members.length})</span>
                      </span>
                    ) : (
                      nameNode(r.id, r.name)
                    )}
                  </td>
                  {repoCells(r, !!me.admin)}
                </tr>,
              ];
              if (isGroup && open) {
                members.forEach((name, i) => {
                  const m = byName[name];
                  const last = i === members.length - 1;
                  rows.push(
                    <tr key={`r-${r.id}-m-${name}`} className={`tree-child${last ? " last" : ""}`}>
                      <td>
                        {m
                          ? nameNode(m.id, name)
                          : <span className="muted">{name}</span>}
                      </td>
                      {m
                        ? repoCells(m, !!me.admin)
                        : <td colSpan={7} className="muted">member not found</td>}
                    </tr>,
                  );
                });
              }
              return rows;
            })}
            {repos.length === 0 && (
              <tr><td colSpan={8} className="muted">No repositories yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
