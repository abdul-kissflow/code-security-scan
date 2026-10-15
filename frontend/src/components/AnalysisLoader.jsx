const STATUS_CLASS = { idle: "pending", running: "active", done: "done", error: "error", cancelled: "cancelled" };

/**
 * The single, prominent "something is happening" view for the whole run -
 * shown in place of the results until every stage (including composing the
 * final report) has settled. Reuses the same checkmark/spinner language as
 * the compact Pipeline strip above it, just scaled up, so there's one visual
 * vocabulary for progress instead of a strip up top and a near-empty page.
 */
export default function AnalysisLoader({ stages }) {
  return (
    <section className="report-card">
      <header className="report-header">
        <h2>Analyzing your codebase</h2>
      </header>
      <p className="muted">This runs a full pass across your code - it can take a few minutes for larger codebases.</p>

      <div className="compose-phases">
        {stages.map((s) => (
          <div key={s.key} className={`compose-phase phase-${STATUS_CLASS[s.status]}`}>
            <span className="compose-phase-icon">
              {s.status === "done" && "✓"}
              {s.status === "error" && "✕"}
              {s.status === "cancelled" && "⊘"}
              {s.status === "running" && <span className="compose-spinner" />}
            </span>
            <span className="compose-phase-label">{s.label}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
