import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Approval, Repository, VersionDeny, api } from "../api";
import { ConfirmModal } from "../components/ConfirmModal";
import { Select } from "../components/Select";

// ApprovalVulnBadge shows the OSV scan result for the requested version so a
// reviewer sees known advisories before approving. Muted dash when clean or not
// yet scanned.
function ApprovalVulnBadge({ severity, ids }: { severity?: string; ids?: string[] }) {
  if (!severity || severity === "none") return <span className="muted">—</span>;
  const bg: Record<string, string> = {
    critical: "var(--danger)", high: "var(--danger)", medium: "#f5a623", low: "#9aa1ac",
  };
  const count = ids?.length ?? 0;
  return (
    <span className="badge" style={{ background: bg[severity] || "#9aa1ac", color: "#fff" }}
      title={count ? ids!.join(", ") : severity}>
      {severity}{count > 1 ? ` ×${count}` : ""}
    </span>
  );
}

// repoLink renders a repository name as a link to its detail Approvals tab when
// the id is known, falling back to plain text (non-admin approvers can't list
// repositories, and the detail page is admin-only anyway).
function repoLink(name: string, ids: Record<string, number>): ReactNode {
  const id = ids[name];
  return id ? <Link to={`/repositories/${id}/approvals`}>{name}</Link> : name;
}

const PAGE = 50;
const STATUSES = ["pending", "approved", "rejected"];

// Approvals is the cross-repository work queue for package approval requests:
// security engineers review demand here, approve or reject with a note, and
// pre-approve packages before anyone asks. Per-repository views reuse
// ApprovalList from the repository detail's Approvals tab.
export function Approvals() {
  const [repo, setRepo] = useState("");
  const [repos, setRepos] = useState<Repository[]>([]);
  const [rows, setRows] = useState<Approval[]>([]);
  const [reloadKey, setReloadKey] = useState(0);
  const [preApproving, setPreApproving] = useState(false);

  useEffect(() => {
    // Repository listing is admin-only; non-admin approvers fall back to repo
    // names seen in the approval rows themselves.
    api.listRepositories()
      .then((r) => setRepos(r.filter((x) => x.type === "proxy")))
      .catch(() => setRepos([]));
  }, []);

  const repoOptions = useMemo(() => {
    const names = new Set(repos.map((r) => r.name));
    rows.forEach((a) => names.add(a.repo_name));
    return [...names].sort();
  }, [repos, rows]);

  const repoIdByName = useMemo(() => {
    const m: Record<string, number> = {};
    repos.forEach((r) => { m[r.name] = r.id; });
    return m;
  }, [repos]);

  return (
    <>
      <div className="page-head">
        <h1>Approvals</h1>
        <button className="btn" onClick={() => setPreApproving(true)}>Add decision</button>
      </div>
      <p className="page-desc">
        Quarantine queue for proxied packages. Approve or reject pending requests before a
        proxy serves them, and block specific poisoned versions outright.
      </p>
      <ApprovalList
        repo={repo}
        showRepo
        reloadKey={reloadKey}
        onRows={setRows}
        repoNames={repoOptions}
        repoIds={repoIdByName}
        filters={
          <Select style={{ width: 200 }} value={repo} onChange={setRepo}
            options={[
              { value: "", label: "all repositories" },
              ...repoOptions.map((name) => ({ value: name, label: name })),
            ]} />
        }
      />
      {preApproving && (
        <PreApproveModal
          repoNames={repoOptions}
          onDone={() => { setPreApproving(false); setReloadKey((k) => k + 1); }}
          onCancel={() => setPreApproving(false)}
        />
      )}
      <VersionDenies repo={repo} showRepo repoNames={repoOptions} repoIds={repoIdByName} />
    </>
  );
}

// ApprovalList renders the approval queue scoped to an optional repository:
// status filter, table, pagination and the approve/reject decision modal.
// Shared by the global Approvals page and the repository detail tab.
export function ApprovalList({ repo = "", showRepo = true, reloadKey = 0, onRows, filters, repoNames = [], repoIds = {} }: {
  repo?: string;
  showRepo?: boolean;
  reloadKey?: number;
  onRows?: (rows: Approval[]) => void;
  filters?: ReactNode;
  // Proxy repository names the bulk-approve modal can target. Empty disables it.
  repoNames?: string[];
  // Maps repository name to id so the Repository column can link to its detail.
  repoIds?: Record<string, number>;
}) {
  const [status, setStatus] = useState("pending");
  const [rows, setRows] = useState<Approval[]>([]);
  const [count, setCount] = useState(0);
  const [pendingCount, setPendingCount] = useState(0);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState("");
  const [deciding, setDeciding] = useState<{ row: Approval; action: "approve" | "reject" } | null>(null);
  const [approvingAll, setApprovingAll] = useState(false);

  useEffect(() => { setOffset(0); }, [repo]);

  const load = useCallback(() => {
    api.listApprovals(repo, status, PAGE, offset)
      .then((res) => { setRows(res.approvals); setCount(res.count); onRows?.(res.approvals); })
      .catch((err) => setError((err as Error).message));
    // Pending count for the targetable scope drives the "Approve all" button.
    api.approvalCount("pending", repo).then((c) => setPendingCount(c.count)).catch(() => setPendingCount(0));
    // onRows is a state setter from the parent; excluding it keeps load stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo, status, offset, reloadKey]);

  useEffect(() => { load(); }, [load]);

  return (
    <>
      <div className="inline" style={{ marginBottom: 14 }}>
        <Select style={{ width: 160 }} value={status}
          onChange={(v) => { setStatus(v); setOffset(0); }}
          options={[
            ...STATUSES.map((s) => ({ value: s, label: s })),
            { value: "", label: "all statuses" },
          ]} />
        {filters}
        <span className="muted">{count} total</span>
        {/* Bulk approve is always offered; the repository is chosen inside the
            modal (defaulting to the active filter), so it works from the global
            queue too. Hidden only when there are no proxy repos to target. */}
        {repoNames.length > 0 && (
          <button className="btn" style={{ marginLeft: "auto" }}
            disabled={pendingCount === 0}
            title={pendingCount === 0 ? "No pending approvals" : undefined}
            onClick={() => setApprovingAll(true)}>Approve all pending</button>
        )}
      </div>
      {error && <div className="error">{error}</div>}
      <div className="panel">
        {rows.length === 0 ? (
          <p className="muted">No {status || "approval"} requests.</p>
        ) : (
          <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {showRepo && <th>Repository</th>}
                <th>Package</th><th>Version</th><th>Vuln</th><th>Requested by</th><th>Requests</th>
                <th>Last requested</th><th>Status</th><th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id}>
                  {showRepo && <td>{repoLink(a.repo_name, repoIds)}</td>}
                  <td style={{ fontFamily: "ui-monospace, monospace", fontSize: 13 }}>{a.package}</td>
                  <td style={{ fontFamily: "ui-monospace, monospace", fontSize: 13 }}>{a.last_requested_version || <span className="muted">—</span>}</td>
                  <td><ApprovalVulnBadge severity={a.vuln_severity} ids={a.vuln_ids} /></td>
                  <td>{a.requested_by || <span className="muted">anonymous</span>}</td>
                  <td>{a.request_count}</td>
                  <td className="muted">{new Date(a.last_requested_at).toLocaleString()}</td>
                  <td>
                    <span className={`badge approval-${a.status}`} title={a.note ? `${a.decided_by}: ${a.note}` : a.decided_by}>
                      {a.status}
                    </span>
                  </td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    {a.status !== "approved" && (
                      <button className="btn" onClick={() => setDeciding({ row: a, action: "approve" })}>Approve</button>
                    )}{" "}
                    {a.status !== "rejected" && (
                      <button className="btn danger" onClick={() => setDeciding({ row: a, action: "reject" })}>Reject</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
        {count > PAGE && (
          <div className="inline" style={{ marginTop: 12 }}>
            <button className="btn secondary" disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - PAGE))}>Newer</button>
            <button className="btn secondary" disabled={offset + PAGE >= count}
              onClick={() => setOffset(offset + PAGE)}>Older</button>
            <span className="muted">{offset + 1}–{Math.min(offset + PAGE, count)} of {count}</span>
          </div>
        )}
      </div>
      {deciding && (
        <DecisionModal
          row={deciding.row}
          action={deciding.action}
          onDone={() => { setDeciding(null); load(); }}
          onCancel={() => setDeciding(null)}
        />
      )}
      {approvingAll && (
        <ApproveAllModal
          repoNames={repoNames}
          initialRepo={repo}
          onDone={() => { setApprovingAll(false); load(); }}
          onCancel={() => setApprovingAll(false)}
        />
      )}
    </>
  );
}

// ApproveAllModal approves every pending package in one repository at once. The
// repository is chosen here (defaulting to the active filter), and the pending
// count for the selection is fetched live so the operator sees the blast radius.
function ApproveAllModal({ repoNames, initialRepo, onDone, onCancel }: {
  repoNames: string[];
  initialRepo?: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [repo, setRepo] = useState(initialRepo || repoNames[0] || "");
  const [note, setNote] = useState("");
  const [pending, setPending] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!repo) { setPending(null); return; }
    let live = true;
    setPending(null);
    api.approvalCount("pending", repo)
      .then((r) => { if (live) setPending(r.count); })
      .catch(() => { if (live) setPending(null); });
    return () => { live = false; };
  }, [repo]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await api.approveAllPending(repo, note);
      onDone();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const single = repoNames.length === 1;
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 style={{ marginTop: 0 }}>Approve all pending</h2>
        <form onSubmit={submit}>
          <label>Proxy repository</label>
          {single ? (
            <input value={repo} disabled />
          ) : (
            <Select value={repo} onChange={setRepo}
              options={repoNames.map((name) => ({ value: name, label: name }))} />
          )}
          <p className="muted" style={{ marginTop: 10 }}>
            {pending === null
              ? "Counting pending requests…"
              : pending === 0
                ? `No pending requests on ${repo}.`
                : `All ${pending} pending ${pending === 1 ? "request" : "requests"} on ${repo} will be approved and served (age policy still applies). This cannot be undone in bulk.`}
          </p>
          <label>Note (optional)</label>
          <input value={note} autoFocus placeholder="reason for the record"
            onChange={(e) => setNote(e.target.value)} />
          {error && <div className="error">{error}</div>}
          <div className="inline" style={{ justifyContent: "flex-end", marginTop: 18 }}>
            <button className="btn secondary" type="button" onClick={onCancel}>Cancel</button>
            <button className="btn" type="submit" disabled={busy || !repo || !pending}>
              {busy ? "Approving…" : pending ? `Approve ${pending}` : "Approve"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// DecisionModal confirms an approve/reject with an optional note (in-app, never
// a native dialog).
function DecisionModal({ row, action, onDone, onCancel }: {
  row: Approval;
  action: "approve" | "reject";
  onDone: () => void;
  onCancel: () => void;
}) {
  const [note, setNote] = useState("");
  const [error, setError] = useState("");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      if (action === "approve") await api.approveApproval(row.id, note);
      else await api.rejectApproval(row.id, note);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 style={{ marginTop: 0 }}>
          {action === "approve" ? "Approve" : "Reject"} "{row.package}"
        </h2>
        <p className="muted">
          {action === "approve"
            ? `All versions of this package will be served from ${row.repo_name} (age policy still applies).`
            : `Requests for this package on ${row.repo_name} will be blocked, including already-cached content.`}
        </p>
        <form onSubmit={submit}>
          <label>Note (optional)</label>
          <input value={note} autoFocus placeholder="reason for the record"
            onChange={(e) => setNote(e.target.value)} />
          {error && <div className="error">{error}</div>}
          <div className="inline" style={{ justifyContent: "flex-end", marginTop: 18 }}>
            <button className="btn secondary" type="button" onClick={onCancel}>Cancel</button>
            <button className={`btn ${action === "reject" ? "danger" : ""}`} type="submit">
              {action === "approve" ? "Approve" : "Reject"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// VersionDenies is the per-version deny list: the package stays approved while
// single poisoned releases are cut off (incident response, IOC blocking). The
// deny overrides package approval and blocks already-cached copies immediately.
// Shared by the global Approvals page and the repository detail tab.
export function VersionDenies({ repo = "", showRepo = true, repoNames, repoIds = {} }: {
  repo?: string;
  showRepo?: boolean;
  repoNames: string[];
  // Maps repository name to id so the Repository column can link to its detail.
  repoIds?: Record<string, number>;
}) {
  const [rows, setRows] = useState<VersionDeny[]>([]);
  const [count, setCount] = useState(0);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<VersionDeny | null>(null);

  useEffect(() => { setOffset(0); }, [repo]);

  const load = useCallback(() => {
    api.listVersionDenies(repo, PAGE, offset)
      .then((res) => { setRows(res.denies); setCount(res.count); })
      .catch((err) => setError((err as Error).message));
  }, [repo, offset]);

  useEffect(() => { load(); }, [load]);

  const remove = async (d: VersionDeny) => {
    setError("");
    try {
      await api.deleteVersionDeny(d.id);
      setRemoving(null);
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <>
      <div className="page-head" style={{ marginTop: 32 }}>
        <h2 style={{ margin: 0 }}>Version denies</h2>
        <button className="btn danger" onClick={() => setAdding(true)}>Deny version</button>
      </div>
      <p className="muted" style={{ marginTop: 4 }}>
        Blocks one exact version even when the package is approved. Applies
        immediately, including already-cached copies.
      </p>
      {error && <div className="error">{error}</div>}
      <div className="panel">
        {rows.length === 0 ? (
          <p className="muted">No denied versions.</p>
        ) : (
          <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {showRepo && <th>Repository</th>}
                <th>Package</th><th>Version</th><th>Reason</th>
                <th>Denied by</th><th>Denied at</th><th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.id}>
                  {showRepo && <td>{repoLink(d.repo_name, repoIds)}</td>}
                  <td style={{ fontFamily: "ui-monospace, monospace", fontSize: 13 }}>{d.package}</td>
                  <td style={{ fontFamily: "ui-monospace, monospace", fontSize: 13 }}>{d.version}</td>
                  <td>{d.reason || <span className="muted">none</span>}</td>
                  <td>{d.created_by || <span className="muted">unknown</span>}</td>
                  <td className="muted">{new Date(d.created_at).toLocaleString()}</td>
                  <td style={{ textAlign: "right" }}>
                    <button className="btn secondary" onClick={() => setRemoving(d)}>Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
        {count > PAGE && (
          <div className="inline" style={{ marginTop: 12 }}>
            <button className="btn secondary" disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - PAGE))}>Newer</button>
            <button className="btn secondary" disabled={offset + PAGE >= count}
              onClick={() => setOffset(offset + PAGE)}>Older</button>
            <span className="muted">{offset + 1}–{Math.min(offset + PAGE, count)} of {count}</span>
          </div>
        )}
      </div>
      {adding && (
        <DenyVersionModal
          repoNames={repoNames}
          initialRepo={repo}
          onDone={() => { setAdding(false); load(); }}
          onCancel={() => setAdding(false)}
        />
      )}
      <ConfirmModal
        open={removing !== null}
        title="Remove deny entry"
        message={removing
          ? `${removing.package}@${removing.version} on ${removing.repo_name} will be served again (approval and age policies still apply).`
          : undefined}
        confirmLabel="Remove"
        onConfirm={() => removing && remove(removing)}
        onCancel={() => setRemoving(null)}
      />
    </>
  );
}

// DenyVersionModal blocks one exact (package, version) in a proxy repository.
function DenyVersionModal({ repoNames, initialRepo, onDone, onCancel }: {
  repoNames: string[];
  initialRepo?: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [repo, setRepo] = useState(initialRepo || (repoNames[0] ?? ""));
  const [pkg, setPkg] = useState("");
  const [version, setVersion] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      await api.createVersionDeny({ repo, package: pkg.trim(), version: version.trim(), reason });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 style={{ marginTop: 0 }}>Deny version</h2>
        <p className="muted">
          Only this exact version is blocked; other versions keep flowing.
          Cached copies stop being served immediately.
        </p>
        <form onSubmit={submit}>
          <label>Proxy repository</label>
          <Select value={repo} onChange={setRepo}
            options={repoNames.map((name) => ({ value: name, label: name }))} />
          <label>Package</label>
          <input value={pkg} placeholder="lodash, @scope/pkg, group:artifact…"
            onChange={(e) => setPkg(e.target.value)} />
          <label>Version</label>
          <input value={version} placeholder="4.17.99 (go modules: v1.2.3)"
            onChange={(e) => setVersion(e.target.value)} />
          <label>Reason (optional)</label>
          <input value={reason} placeholder="CVE, IOC, incident reference…"
            onChange={(e) => setReason(e.target.value)} />
          {error && <div className="error">{error}</div>}
          <div className="inline" style={{ justifyContent: "flex-end", marginTop: 18 }}>
            <button className="btn secondary" type="button" onClick={onCancel}>Cancel</button>
            <button className="btn danger" type="submit" disabled={!repo || !pkg.trim() || !version.trim()}>
              Deny
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// PreApproveModal records a decision for a package nobody has requested yet.
function PreApproveModal({ repoNames, onDone, onCancel }: {
  repoNames: string[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const [repo, setRepo] = useState(repoNames[0] ?? "");
  const [pkg, setPkg] = useState("");
  const [decision, setDecision] = useState("approved");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      await api.createApproval({ repo, package: pkg.trim(), status: decision, note });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 style={{ marginTop: 0 }}>Add decision</h2>
        <form onSubmit={submit}>
          <label>Proxy repository</label>
          <Select value={repo} onChange={setRepo}
            options={repoNames.map((name) => ({ value: name, label: name }))} />
          <label>Package</label>
          <input value={pkg} placeholder="lodash, @scope/pkg, group:artifact…"
            onChange={(e) => setPkg(e.target.value)} />
          <label>Decision</label>
          <Select value={decision} onChange={setDecision}
            options={[
              { value: "approved", label: "approved" },
              { value: "rejected", label: "rejected" },
            ]} />
          <label>Note (optional)</label>
          <input value={note} onChange={(e) => setNote(e.target.value)} />
          {error && <div className="error">{error}</div>}
          <div className="inline" style={{ justifyContent: "flex-end", marginTop: 18 }}>
            <button className="btn secondary" type="button" onClick={onCancel}>Cancel</button>
            <button className="btn" type="submit" disabled={!repo || !pkg.trim()}>Save</button>
          </div>
        </form>
      </div>
    </div>
  );
}
