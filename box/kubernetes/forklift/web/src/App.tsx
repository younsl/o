import { useEffect, useState } from "react";
import { Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { api, Me } from "./api";
import { Logo } from "./components/Logo";
import { Login } from "./pages/Login";
import { Repositories } from "./pages/Repositories";
import { RepositoryNew } from "./pages/RepositoryNew";
import { RepositoryDetail } from "./pages/RepositoryDetail";
import { Tokens } from "./pages/Tokens";
import { TokenNew } from "./pages/TokenNew";
import { Approvals } from "./pages/Approvals";
import { ApprovalDetail } from "./pages/ApprovalDetail";
import { Users } from "./pages/Users";
import { UserNew } from "./pages/UserNew";
import { UserModify } from "./pages/UserModify";
import { Roles } from "./pages/Roles";
import { RoleNew } from "./pages/RoleNew";
import { RoleModify } from "./pages/RoleModify";

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = () => api.me().then(setMe).catch(() => setMe({ authenticated: false }));

  useEffect(() => {
    refresh().finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="login-wrap">Loading…</div>;

  if (!me?.authenticated) {
    return <Login onLogin={refresh} />;
  }

  return (
    <div className="app">
      <Sidebar me={me} onLogout={() => api.logout().then(refresh)} />
      <div className="main">
        <Routes>
          <Route path="/" element={<Navigate to="/repositories" replace />} />
          <Route path="/repositories" element={<Repositories me={me} />} />
          <Route path="/repositories/new" element={<RepositoryNew />} />
          <Route path="/repositories/:id/:tab?" element={<RepositoryDetail me={me} />} />
          <Route path="/tokens" element={<Tokens />} />
          <Route path="/tokens/new" element={<TokenNew />} />
          {(me.admin || me.approver) && <Route path="/approvals" element={<Approvals />} />}
          {(me.admin || me.approver) && <Route path="/approvals/:id" element={<ApprovalDetail />} />}
          {(me.admin || me.auditor) && <Route path="/users" element={<Users me={me} />} />}
          {me.admin && <Route path="/users/new" element={<UserNew />} />}
          {(me.admin || me.auditor) && <Route path="/users/:id" element={<UserModify me={me} />} />}
          {(me.admin || me.auditor) && <Route path="/roles" element={<Roles me={me} />} />}
          {me.admin && <Route path="/roles/new" element={<RoleNew />} />}
          {(me.admin || me.auditor) && <Route path="/roles/:id" element={<RoleModify me={me} />} />}
          <Route path="*" element={<Navigate to="/repositories" replace />} />
        </Routes>
      </div>
    </div>
  );
}

function Sidebar({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [repoCount, setRepoCount] = useState<number | null>(null);
  const [pendingCount, setPendingCount] = useState<number | null>(null);
  const [version, setVersion] = useState<{ version: string; commit: string } | null>(null);

  const canApprove = Boolean(me.admin || me.approver);
  useEffect(() => {
    api.listRepositories().then((r) => setRepoCount(r.length)).catch(() => setRepoCount(null));
    if (canApprove) {
      api.approvalCount().then((r) => setPendingCount(r.count)).catch(() => setPendingCount(null));
    }
  }, [location.pathname, canApprove]);

  useEffect(() => {
    api.version().then((v) => setVersion(v)).catch(() => setVersion(null));
  }, []);

  return (
    <div className="sidebar">
      <div className="brand-block">
        <Link to="/repositories" className="brand"><Logo /><span className="brand-text">fork<span>lift</span></span></Link>
        {version && (
          <span className="brand-version">
            {version.version}
            {version.commit && version.commit !== "none" && (
              <span className="brand-commit"> ({version.commit.slice(0, 7)})</span>
            )}
          </span>
        )}
      </div>
      <NavLink className="navlink nav-flex" to="/repositories">
        <span>Repositories</span>
        {repoCount !== null && <span className="count-badge">{repoCount}</span>}
      </NavLink>
      <NavLink className="navlink" to="/tokens">Access Tokens</NavLink>
      {canApprove && (
        <NavLink className="navlink nav-flex" to="/approvals">
          <span>Approvals</span>
          {pendingCount !== null && pendingCount > 0 && <span className="count-badge">{pendingCount}</span>}
        </NavLink>
      )}
      {(me.admin || me.auditor) && <NavLink className="navlink" to="/users">Users</NavLink>}
      {(me.admin || me.auditor) && <NavLink className="navlink" to="/roles">Roles</NavLink>}
      <div className="spacer" />
      <a className="navlink" href="/api-docs" target="_blank" rel="noreferrer">API Docs ↗</a>
      <div className="userbox">
        <div>{me.username} {me.admin ? "(admin)" : me.auditor ? "(auditor)" : ""}</div>
        <button type="button" className="btn secondary logout-btn"
          onClick={() => { onLogout(); navigate("/"); }}>Log Out</button>
      </div>
    </div>
  );
}
