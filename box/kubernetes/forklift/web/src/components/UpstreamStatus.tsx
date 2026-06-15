import { useEffect, useState } from "react";
import { api, UpstreamHealth } from "../api";

// UpstreamStatus probes a proxy repository's upstream and renders a health
// badge. compact shows only reachable/unreachable (list view); the full form
// (detail view) also shows the status code and latency. withButton adds a
// "Recheck" action.
export function UpstreamStatus({
  repoId,
  withButton,
  compact,
}: {
  repoId: number;
  withButton?: boolean;
  compact?: boolean;
}) {
  const [h, setH] = useState<UpstreamHealth | null>(null);
  const [loading, setLoading] = useState(true);

  const check = () => {
    setLoading(true);
    api
      .upstreamHealth(repoId)
      .then(setH)
      .catch(() => setH({ applicable: true, reachable: false, error: "check failed" }))
      .finally(() => setLoading(false));
  };
  useEffect(check, [repoId]);

  let badge;
  if (loading) badge = <span className="status"><span className="dot" /> checking…</span>;
  else if (!h || !h.applicable) badge = <span className="status">—</span>;
  else if (h.reachable)
    badge = (
      <span className="status">
        <span className="dot ok" /> reachable{!compact && <> · {h.status} · {h.latency_ms}ms</>}
      </span>
    );
  else
    badge = <span className="status" title={h.error}><span className="dot bad" /> unreachable</span>;

  if (!withButton) return badge;
  return (
    <span className="inline" style={{ gap: 10 }}>
      {badge}
      <button className="btn secondary" type="button" onClick={check} disabled={loading}>Recheck</button>
    </span>
  );
}
