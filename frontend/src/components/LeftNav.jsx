import { Link } from "react-router-dom";

const STATUS_ICON = { running: "", done: "✓", error: "✕", cancelled: "⊘" };

function ScoreBadge({ score }) {
  if (score == null) return null;
  const color = score >= 85 ? "var(--success)" : score >= 60 ? "var(--warning)" : "var(--danger)";
  return (
    <span className="left-nav-score" style={{ color }}>
      {score}
    </span>
  );
}

/** The current user's past health checks - clicking one loads it in the main pane. */
export default function LeftNav({ scans, activeId, loaded }) {
  return (
    <nav className="left-nav">
      <Link to="/app" className="btn-small left-nav-upload">
        + Upload new codebase
      </Link>

      <div className="left-nav-list">
        {loaded && scans.length === 0 && <p className="muted left-nav-empty">No scans yet.</p>}
        {scans.map((s) => (
          <Link key={s.id} to={`/app/scans/${s.id}`} className={`left-nav-item${s.id === activeId ? " active" : ""}`}>
            <span className={`left-nav-dot dot-${s.overallStatus}`}>{STATUS_ICON[s.overallStatus]}</span>
            <span className="left-nav-name" title={s.originalName}>
              {s.originalName}
            </span>
            {/* No score for an aborted run - same reasoning as the "Run aborted" banner: a
                number built from an incomplete run would be misleading, not just unavailable. */}
            {s.overallStatus !== "cancelled" && <ScoreBadge score={s.healthScore} />}
          </Link>
        ))}
      </div>
    </nav>
  );
}
