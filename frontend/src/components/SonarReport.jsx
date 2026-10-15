import { useMemo, useState } from "react";
import SeverityBadge from "./SeverityBadge.jsx";
import { sortBySeverity } from "../severity.js";

const MEASURE_LABELS = {
  bugs: "Bugs",
  vulnerabilities: "Vulnerabilities",
  code_smells: "Code smells",
  security_hotspots: "Security hotspots",
  coverage: "Coverage %",
  duplicated_lines_density: "Duplicated lines %",
  ncloc: "Lines of code",
  alert_status: "Quality gate",
};

const SEVERITIES = ["BLOCKER", "CRITICAL", "MAJOR", "MINOR", "INFO"];
const TYPES = ["BUG", "VULNERABILITY", "CODE_SMELL"];

function IssuesTable({ issues, total }) {
  const [severityFilter, setSeverityFilter] = useState("ALL");
  const [typeFilter, setTypeFilter] = useState("ALL");
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const matched = issues.filter((i) => {
      if (severityFilter !== "ALL" && i.severity !== severityFilter) return false;
      if (typeFilter !== "ALL" && i.type !== typeFilter) return false;
      if (q && !`${i.rule} ${i.component} ${i.message}`.toLowerCase().includes(q)) return false;
      return true;
    });
    return sortBySeverity(matched);
  }, [issues, severityFilter, typeFilter, search]);

  return (
    <>
      <div className="issue-filters">
        <select value={severityFilter} onChange={(e) => setSeverityFilter(e.target.value)}>
          <option value="ALL">All severities</option>
          {SEVERITIES.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
          <option value="ALL">All types</option>
          {TYPES.map((t) => (
            <option key={t} value={t}>{t.replace("_", " ")}</option>
          ))}
        </select>
        <input
          type="text"
          placeholder="Filter by rule, file, or message…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <span className="muted">
          Showing {filtered.length} of {issues.length} fetched{total > issues.length ? ` (${total} total on server)` : ""}
        </span>
      </div>

      <table className="report-table">
        <thead>
          <tr>
            <th>Severity</th>
            <th>Type</th>
            <th>Rule</th>
            <th>Component</th>
            <th>Line</th>
            <th>Message</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((i) => (
            <tr key={i.key}>
              <td><SeverityBadge severity={i.severity} /></td>
              <td>{i.type?.replace("_", " ")}</td>
              <td><code>{i.rule}</code></td>
              <td><code>{i.component}</code></td>
              <td>{i.line ?? "—"}</td>
              <td>{i.message}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

export default function SonarReport({ state }) {
  if (state.status === "idle") return null;

  return (
    <section className="report-card">
      <header className="report-header">
        <h2>Code Analysis</h2>
      </header>

      {state.status === "running" && (
        <p className="muted">Analyzing the uploaded codebase — this can take a minute or two…</p>
      )}
      {state.status === "error" && <p className="error-text">{state.error}</p>}

      {state.status === "done" && (
        <>
          {state.data.note && <p className="muted">{state.data.note}</p>}
          <p className="summary-line">
            Quality gate:{" "}
            <span className={state.data.qualityGateStatus === "OK" ? "ok-text" : "warn-text"}>
              {state.data.qualityGateStatus || "unknown"}
            </span>
          </p>

          {state.data.measures && (
            <div className="measure-grid">
              {Object.entries(state.data.measures).map(([key, value]) => (
                <div key={key} className="measure-tile">
                  <div className="measure-value">{value}</div>
                  <div className="measure-label">{MEASURE_LABELS[key] || key}</div>
                </div>
              ))}
            </div>
          )}
          {state.data.measuresError && <p className="error-text">Measures: {state.data.measuresError}</p>}

          <h3>All open issues ({state.data.issuesTotal ?? state.data.issues?.length ?? 0})</h3>
          {state.data.issuesError && <p className="error-text">{state.data.issuesError}</p>}
          {state.data.issues?.length > 0 ? (
            <IssuesTable issues={state.data.issues} total={state.data.issuesTotal ?? state.data.issues.length} />
          ) : (
            !state.data.issuesError && <p className="ok-text">No open issues.</p>
          )}

          <h3>Security hotspots to review ({state.data.securityHotspots?.length ?? 0})</h3>
          {state.data.securityHotspotsError && <p className="error-text">{state.data.securityHotspotsError}</p>}
          {state.data.securityHotspots?.length > 0 && (
            <table className="report-table">
              <thead>
                <tr>
                  <th>Risk</th>
                  <th>Rule</th>
                  <th>Component</th>
                  <th>Line</th>
                  <th>Message</th>
                </tr>
              </thead>
              <tbody>
                {sortBySeverity(state.data.securityHotspots, (h) => h.vulnerabilityProbability).map((h) => (
                  <tr key={h.key}>
                    <td><SeverityBadge severity={h.vulnerabilityProbability} /></td>
                    <td><code>{h.rule}</code></td>
                    <td><code>{h.component}</code></td>
                    <td>{h.line ?? "—"}</td>
                    <td>{h.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}
