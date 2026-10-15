import { useEffect, useMemo, useRef, useState } from "react";
import SeverityBadge from "./SeverityBadge.jsx";
import { SOURCE_LABEL } from "../toolLabels.js";
import { sortBySeverity } from "../severity.js";

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

const TOOLS = ["eslint", "typescript", "stylelint", "suppression"];
const SEVERITIES = ["critical", "high", "medium", "low", "info"];

function FindingsTable({ findings }) {
  const [toolFilter, setToolFilter] = useState("ALL");
  const [severityFilter, setSeverityFilter] = useState("ALL");
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const matched = findings.filter((f) => {
      if (toolFilter !== "ALL" && f.tool !== toolFilter) return false;
      if (severityFilter !== "ALL" && f.severity !== severityFilter) return false;
      if (q && !`${f.rule} ${f.file} ${f.message}`.toLowerCase().includes(q)) return false;
      return true;
    });
    return sortBySeverity(matched);
  }, [findings, toolFilter, severityFilter, search]);

  return (
    <>
      <div className="issue-filters">
        <select value={toolFilter} onChange={(e) => setToolFilter(e.target.value)}>
          <option value="ALL">All categories</option>
          {TOOLS.map((t) => (
            <option key={t} value={t}>{SOURCE_LABEL[t]}</option>
          ))}
        </select>
        <select value={severityFilter} onChange={(e) => setSeverityFilter(e.target.value)}>
          <option value="ALL">All severities</option>
          {SEVERITIES.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <input
          type="text"
          placeholder="Filter by rule, file, or message…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <span className="muted">Showing {filtered.length} of {findings.length}</span>
      </div>

      <table className="report-table">
        <thead>
          <tr>
            <th>Severity</th>
            <th>Category</th>
            <th>Rule</th>
            <th>File</th>
            <th>Line</th>
            <th>Message</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((f, i) => (
            <tr key={i}>
              <td><SeverityBadge severity={f.severity} /></td>
              <td>{SOURCE_LABEL[f.tool] || f.tool}</td>
              <td><code>{f.rule}</code></td>
              <td><code>{f.file}</code></td>
              <td>{f.line ?? "—"}</td>
              <td>{f.message}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

export default function CodeQualityReport({ state }) {
  return (
    <section className="report-card">
      <header className="report-header">
        <h2>Code Quality</h2>
      </header>

      <p className="muted">
        Checks your code against a strict, consistent set of best-practice rules covering code standards,
        type safety, and styling.
      </p>

      {state.status === "running" && (
        <>
          <p className="muted">
            Live progress below — this check installs the project's dependencies first, so it can take a
            little longer than the others.
          </p>
          <LiveLog log={state.log} />
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
          <p className="summary-line">
            {state.data.totalFindings} finding{state.data.totalFindings === 1 ? "" : "s"}
            <span className="muted">
              {" "}
              · Code Standards {state.data.eslint.totalFindings} · Type Safety {state.data.typescript.totalFindings} ·
              Styling {state.data.stylelint.totalFindings}
              {state.data.suppressions && <> · Suppressed Checks {state.data.suppressions.totalFindings}</>}
            </span>
          </p>

          {state.data.scope?.profile === "kissflow-starter" && (
            <p className="muted">
              Kissflow starter app detected —{" "}
              {state.data.scope.scopedFileCount == null
                ? "scanned the whole tree (the app's imports couldn't all be traced)."
                : `scanned only the ${state.data.scope.scopedFileCount} file(s) the app actually uses.`}{" "}
              Type checking is skipped (plain JS/JSX).
            </p>
          )}

          {state.data.typescript.dependenciesInstalled === false && (
            <p className="warn-text">
              Some dependencies failed to install, so the results below may be incomplete.
            </p>
          )}

          {state.log?.length > 0 && (
            <details>
              <summary>Show run log ({state.log.length} events)</summary>
              <LiveLog log={state.log} />
            </details>
          )}

          {state.data.totalFindings > 0 ? (
            <FindingsTable findings={state.data.findings} />
          ) : (
            <p className="ok-text">No findings.</p>
          )}
        </>
      )}
    </section>
  );
}
