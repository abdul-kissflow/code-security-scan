import { useEffect, useRef } from "react";
import CopyJsonButton from "./CopyJsonButton.jsx";
import GroupCard from "./GroupCard.jsx";

const EVENT_CLASS = {
  status: "log-status",
  tool: "log-tool",
  heartbeat: "log-heartbeat",
  summary: "log-summary",
  text: "log-text",
};

function LiveLog({ log }) {
  const endRef = useRef(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [log.length]);

  return (
    <div className="live-log">
      {log.length === 0 && <p className="muted">Waiting to start…</p>}
      {log.map((evt, i) => (
        <div key={i} className={`log-line ${EVENT_CLASS[evt.type] || ""}`}>
          {evt.text}
        </div>
      ))}
      <div ref={endRef} />
    </div>
  );
}

const COMPOSE_PHASES = [
  { key: "group", label: "Grouping related findings" },
  { key: "analyze", label: "Reading your code" },
  { key: "write", label: "Writing your report" },
];

// Coarse, honestly-derived phases (not a fake/simulated progress bar) - the
// backend doesn't emit an explicit "phase" field, so this reads the same
// real event stream LiveLog does and buckets it into 3 steps a non-technical
// reader can follow, instead of a scrolling log of file paths and rule text.
function composePhaseStatus(log) {
  const hasAny = log.length > 0;
  const hasSummary = log.some((e) => e.type === "summary");
  return {
    group: hasAny ? "done" : "active",
    analyze: !hasAny ? "pending" : hasSummary ? "done" : "active",
    write: hasSummary ? "active" : "pending",
  };
}

function ComposingProgress({ log }) {
  const status = composePhaseStatus(log);
  return (
    <div className="compose-phases">
      {COMPOSE_PHASES.map((p) => (
        <div key={p.key} className={`compose-phase phase-${status[p.key]}`}>
          <span className="compose-phase-icon">
            {status[p.key] === "done" ? "✓" : status[p.key] === "active" ? <span className="compose-spinner" /> : ""}
          </span>
          <span className="compose-phase-label">{p.label}</span>
        </div>
      ))}
    </div>
  );
}

export default function ExplainReport({ state, onRun, canRun }) {
  return (
    <section className="report-card">
      <header className="report-header">
        <h2>Final Report</h2>
      </header>

      <p className="muted">
        Groups related findings from the checks above and explains what each one means, why it matters, and
        how to fix it.
      </p>

      {state.status !== "running" && (
        <button className="btn" disabled={!canRun} onClick={onRun}>
          {state.status === "done" ? "Regenerate report" : "Generate report"}
        </button>
      )}
      {!canRun && state.status === "idle" && (
        <p className="muted">Run the checks above first.</p>
      )}

      {state.status === "running" && (
        <>
          <p className="muted">Composing your report — this can take a little while for larger codebases.</p>
          <ComposingProgress log={state.log} />
          {state.log?.length > 0 && (
            <details className="compose-details">
              <summary>Show technical log ({state.log.length} events)</summary>
              <LiveLog log={state.log} />
            </details>
          )}
        </>
      )}
      {state.status === "error" && (
        <>
          <p className="error-text">{state.error}</p>
          {state.log?.length > 0 && <LiveLog log={state.log} />}
        </>
      )}

      {state.status === "done" && (
        <>
          <div className="summary-line-row">
            <p className="summary-line">
              {state.data.findingsCount} finding{state.data.findingsCount === 1 ? "" : "s"} grouped into{" "}
              {state.data.groups.length} issue{state.data.groups.length === 1 ? "" : "s"}
              {typeof state.data.totalInputTokens === "number" && (
                <span className="muted">
                  {" "}
                  · {state.data.totalInputTokens.toLocaleString()} in / {state.data.totalOutputTokens.toLocaleString()} out tokens
                </span>
              )}
            </p>
            <CopyJsonButton groups={state.data.groups} />
          </div>

          {state.log?.length > 0 && (
            <details>
              <summary>Show run log ({state.log.length} events)</summary>
              <LiveLog log={state.log} />
            </details>
          )}

          {state.data.groups.map((g, i) => (
            <GroupCard key={i} group={g} />
          ))}
        </>
      )}
    </section>
  );
}
