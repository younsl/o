import { ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Approval, api } from "../api";
import { ReviewModal, SeverityBar, SEV_COLOR } from "./Approvals";
import { Tooltip } from "../components/Tooltip";

// ApprovalDetail is the per-request review screen: it shows the full approval
// metadata and the OSV vulnerability analysis (OVS) so a reviewer can judge the
// package before deciding. The decision itself is made in the shared ReviewModal.
export function ApprovalDetail() {
  const { id } = useParams();
  const approvalId = Number(id);
  const [row, setRow] = useState<Approval | null>(null);
  const [error, setError] = useState("");
  const [reviewing, setReviewing] = useState(false);

  const load = useCallback(() => {
    api.getApproval(approvalId)
      .then(setRow)
      .catch((e) => setError((e as Error).message));
  }, [approvalId]);

  useEffect(() => { load(); }, [load]);

  if (error && !row) return <div className="error">{error}</div>;
  if (!row) return <div>Loading…</div>;

  return (
    <>
      <div className="page-head">
        <h1 style={{ fontFamily: "ui-monospace, monospace" }}>
          {row.package} <span className={`badge approval-${row.status}`}>{row.status}</span>
        </h1>
        <div className="inline">
          <button className="btn" onClick={() => setReviewing(true)}>Review</button>
          <Link className="btn secondary" to="/approvals">Back to approvals</Link>
        </div>
      </div>
      {error && <div className="error">{error}</div>}

      <div className="panel">
        <h2>Request</h2>
        <dl className="kv">
          <dt>Repository</dt><dd>{row.repo_name}</dd>
          <dt>Package</dt><dd style={{ fontFamily: "ui-monospace, monospace" }}>{row.package}</dd>
          <dt>Requested version</dt>
          <dd style={{ fontFamily: "ui-monospace, monospace" }}>
            {row.last_requested_version || <span className="muted">unknown (metadata request blocked before a version was resolved)</span>}
          </dd>
          <dt>Requested by</dt><dd>{row.requested_by || <span className="muted">anonymous</span>}</dd>
          <dt>Requests</dt><dd>{row.request_count}</dd>
          <dt>First requested</dt><dd className="muted">{new Date(row.first_requested_at).toLocaleString()}</dd>
          <dt>Last requested</dt><dd className="muted">{new Date(row.last_requested_at).toLocaleString()}</dd>
          {row.decided_by && <><dt>Decided by</dt><dd>{row.decided_by}</dd></>}
          {row.decided_at && <><dt>Decided at</dt><dd className="muted">{new Date(row.decided_at).toLocaleString()}</dd></>}
          {row.note && <><dt>Note</dt><dd>{row.note}</dd></>}
        </dl>
      </div>

      <OvsAnalysis row={row} />

      <ReviewersPanel reviewers={row.reviewers} />

      {reviewing && (
        <ReviewModal
          row={row}
          onDone={() => { setReviewing(false); load(); }}
          onCancel={() => setReviewing(false)}
        />
      )}
    </>
  );
}

// OvsAnalysis renders the OSV scan result: a large severity bar, the scan
// metadata (result, scope, when, how long), and a table of advisories with
// id, severity, CVSS score and a link to osv.dev. Empty until the async scan
// lands.
function OvsAnalysis({ row }: { row: Approval }) {
  const advisories = row.vuln_advisories ?? [];
  const ids = row.vuln_ids ?? [];
  const pkgScope = row.vuln_scope === "package";
  const clean = row.vuln_severity === "none";
  return (
    <div className="panel">
      <h2>Vulnerability analysis</h2>
      {row.vuln_severity === undefined ? (
        <p className="muted" style={{ marginBottom: 0 }}>
          Not scanned yet. The scan runs asynchronously after the request is
          queued; reload in a moment.
        </p>
      ) : (
        <>
          <div style={{ margin: "8px 0 18px" }}>
            <SeverityBar severity={row.vuln_severity} counts={row.vuln_counts} scope={row.vuln_scope} source={row.vuln_source} scannedAt={row.vuln_scanned_at} size="lg" />
          </div>
          <dl className="kv">
            <dt>Data source</dt>
            <dd>
              {!row.vuln_source || row.vuln_source === "OSV"
                ? <a href="https://osv.dev" target="_blank" rel="noreferrer">OSV (osv.dev)</a>
                : row.vuln_source}
            </dd>
            <dt>Result</dt>
            <dd>{clean ? "Clean (no known advisories)" : <>Vulnerable, highest severity <strong>{row.vuln_severity}</strong></>}</dd>
            <dt>Scope</dt>
            <dd>{pkgScope ? "Package-level (all versions; requested version unknown)" : `Version ${row.last_requested_version}`}</dd>
            <dt>Scanned at</dt>
            <dd className="muted">{row.vuln_scanned_at ? new Date(row.vuln_scanned_at).toLocaleString() : "n/a"}</dd>
            <dt>Duration</dt>
            <dd className="muted">{row.vuln_scan_ms != null ? `${row.vuln_scan_ms} ms` : "n/a"}</dd>
          </dl>
          {advisories.length > 0 ? (
            <AdvisoryTable advisories={advisories} />
          ) : ids.length > 0 ? (
            <ul className="advisory-list">
              {ids.map((vid) => (
                <li key={vid}><a href={`https://osv.dev/${vid}`} target="_blank" rel="noreferrer">{vid}</a></li>
              ))}
            </ul>
          ) : (
            <p style={{ marginBottom: 0 }}>No known advisories.</p>
          )}
        </>
      )}
    </div>
  );
}

type Advisory = { id: string; severity: string; score?: string };
type SortKey = "idx" | "id" | "severity" | "cvss";
const SEV_RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };

// SortIcon is a stacked up/down chevron drawn inline as SVG (no icon library).
// When inactive both chevrons are muted to signal the column is sortable; when
// active the sorted direction is accented and the other dimmed.
function SortIcon({ state }: { state: "asc" | "desc" | null }) {
  const up = state === "asc" ? "var(--accent)" : state === "desc" ? "var(--border)" : "var(--muted)";
  const down = state === "desc" ? "var(--accent)" : state === "asc" ? "var(--border)" : "var(--muted)";
  return (
    <svg className="sort-icon" width="11" height="14" viewBox="0 0 11 14" aria-hidden="true" focusable="false">
      <path d="M2 5 L5.5 1.5 L9 5" fill="none" stroke={up} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M2 9 L5.5 12.5 L9 9" fill="none" stroke={down} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// AdvisoryTable renders the scan's advisories with every column sortable
// ascending/descending. The header cells are sort buttons; the active column
// shows ▲/▼ and the rest show ↕ to signal they are sortable. # sorts by the
// original (as-scanned) order, severity by rank, and CVSS numerically.
function AdvisoryTable({ advisories }: { advisories: Advisory[] }) {
  const [key, setKey] = useState<SortKey>("idx");
  const [dir, setDir] = useState<"asc" | "desc">("asc");

  const cvss = (a: Advisory) => {
    const n = parseFloat(a.score ?? "");
    return Number.isNaN(n) ? -1 : n;
  };
  const sorted = useMemo(() => {
    const rows = advisories.map((a, i) => ({ a, i }));
    rows.sort((x, y) => {
      let d = 0;
      switch (key) {
        case "idx": d = x.i - y.i; break;
        case "id": d = x.a.id.localeCompare(y.a.id); break;
        case "severity": d = (SEV_RANK[x.a.severity] ?? 0) - (SEV_RANK[y.a.severity] ?? 0); break;
        case "cvss": d = cvss(x.a) - cvss(y.a); break;
      }
      return dir === "asc" ? d : -d;
    });
    return rows;
  }, [advisories, key, dir]);

  const onSort = (k: SortKey) => {
    if (k === key) setDir(dir === "asc" ? "desc" : "asc");
    else { setKey(k); setDir("asc"); }
  };
  const SortBtn = ({ k, children }: { k: SortKey; children: ReactNode }) => (
    <button type="button" className="sort-btn" onClick={() => onSort(k)}
      aria-label={`Sort by ${k}`}>
      {children}
      <SortIcon state={key === k ? dir : null} />
    </button>
  );

  return (
    <div className="table-wrap" style={{ marginTop: 16 }}>
      <table>
        <thead>
          <tr>
            <th style={{ width: 56 }}><SortBtn k="idx">#</SortBtn></th>
            <th><SortBtn k="id">Advisory ID</SortBtn></th>
            <th><SortBtn k="severity">Severity</SortBtn></th>
            <th>
              <SortBtn k="cvss">CVSS</SortBtn>
              <Tooltip text="This is the CVSS version 3.x base score, which ranges from 0 to 10 and is calculated from the advisory's CVSS vector. A higher number means a more severe vulnerability. A score of 9.0 or above is critical, 7.0 or above is high, 4.0 or above is medium, and anything above 0 is low.">
                <span className="help">ⓘ</span>
              </Tooltip>
            </th>
          </tr>
        </thead>
        <tbody>
          {sorted.map(({ a, i }) => (
            <tr key={a.id}>
              <td className="muted">{i + 1}</td>
              <td style={{ fontFamily: "ui-monospace, monospace", fontSize: 13 }}>
                <a href={`https://osv.dev/${a.id}`} target="_blank" rel="noreferrer">{a.id}</a>
              </td>
              <td><span className="badge" style={{ background: SEV_COLOR[a.severity] ?? "#9aa1ac", color: "#fff" }}>{a.severity}</span></td>
              <td style={{ fontVariantNumeric: "tabular-nums" }}>{a.score || <span className="muted">n/a</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ReviewersPanel lists the users permitted to approve this repository, so it is
// clear who can act on the request. OIDC-group approvers who have never signed
// in are not enumerable and so are not shown.
function ReviewersPanel({ reviewers }: { reviewers?: string[] }) {
  return (
    <div className="panel">
      <h2>
        Reviewers <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>· users who can approve this repository</span>
      </h2>
      {!reviewers || reviewers.length === 0 ? (
        <p className="muted" style={{ marginBottom: 0 }}>No users currently have approve permission for this repository.</p>
      ) : (
        <div className="inline" style={{ flexWrap: "wrap", gap: 8 }}>
          {reviewers.map((u) => <span key={u} className="badge">{u}</span>)}
        </div>
      )}
    </div>
  );
}
