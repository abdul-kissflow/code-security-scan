import SeverityBadge from "./SeverityBadge.jsx";
import { sortBySeverity } from "../severity.js";

export default function SecretsReport({ state }) {
  if (state.status === "idle") return null;

  return (
    <section className="report-card">
      <header className="report-header">
        <h2>Hardcoded Secrets & Tokens</h2>
      </header>

      {state.status === "running" && <p className="muted">Scanning for hardcoded secrets…</p>}
      {state.status === "error" && <p className="error-text">{state.error}</p>}

      {state.status === "done" && (
        <>
          <p className="summary-line">
            {state.data.totalFindings === 0 ? (
              <span className="ok-text">No hardcoded secrets found.</span>
            ) : (
              <span className="warn-text">
                {state.data.totalFindings} potential secret{state.data.totalFindings === 1 ? "" : "s"} found.
              </span>
            )}
          </p>

          {state.data.excludedKnownBenignCount > 0 && (
            <p className="muted">
              Not counted: {state.data.excludedKnownBenignCount} match{state.data.excludedKnownBenignCount === 1 ? "" : "es"} in{" "}
              {state.data.excludedKnownBenignPaths.join(", ")} — .env files are where credentials belong, and cert/ holds
              the local-dev certificate.
            </p>
          )}

          {state.data.totalFindings > 0 && (
            <table className="report-table">
              <thead>
                <tr>
                  <th>Severity</th>
                  <th>Rule</th>
                  <th>File</th>
                  <th>Line</th>
                  <th>Description</th>
                </tr>
              </thead>
              <tbody>
                {sortBySeverity(state.data.findings).map((f, i) => (
                  <tr key={i}>
                    <td><SeverityBadge severity={f.severity} /></td>
                    <td><code>{f.rule}</code></td>
                    <td><code>{f.file}</code></td>
                    <td>{f.line ?? "—"}</td>
                    <td>{f.description}</td>
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
