import SeverityBadge from "./SeverityBadge.jsx";
import { sortBySeverity } from "../severity.js";

export default function DependencyReport({ state }) {
  if (state.status === "idle") return null;

  return (
    <section className="report-card">
      <header className="report-header">
        <h2>Vulnerable Dependencies</h2>
      </header>

      {state.status === "running" && <p className="muted">Checking dependencies for known vulnerabilities…</p>}
      {state.status === "error" && <p className="error-text">{state.error}</p>}

      {state.status === "done" && (
        <>
          {state.data.note && <p className="muted">{state.data.note}</p>}

          {state.data.projects?.map((proj, i) => (
            <div key={i} className="subsection">
              <h3>
                <code>{proj.dir}</code>
                {proj.ok && proj.summary && (
                  <span className="summary-inline">
                    {" "}— {proj.summary.total} vulnerabilit{proj.summary.total === 1 ? "y" : "ies"} across{" "}
                    {proj.totalDependencies ?? "?"} dependencies
                  </span>
                )}
              </h3>

              {!proj.ok && <p className="error-text">{proj.error}</p>}

              {proj.excludedBaselineCount > 0 && (
                <p className="muted">
                  Not counted: {proj.excludedBaselineCount} vulnerable package{proj.excludedBaselineCount === 1 ? "" : "s"} that ship with
                  the Kissflow starter scaffold ({proj.excludedBaselinePackages.join(", ")}).
                </p>
              )}

              {proj.skippedWorkspaceDeps?.length > 0 && (
                <p className="muted">
                  Not audited: {proj.skippedWorkspaceDeps.join(", ")} - local workspace package
                  {proj.skippedWorkspaceDeps.length === 1 ? "" : "s"} not included in the upload or published to npm.
                </p>
              )}

              {proj.ok && proj.vulnerabilities.length === 0 && (
                <p className="ok-text">No known vulnerabilities.</p>
              )}

              {proj.ok && proj.vulnerabilities.length > 0 && (
                <table className="report-table">
                  <thead>
                    <tr>
                      <th>Severity</th>
                      <th>Package</th>
                      <th>Direct?</th>
                      <th>Fix available</th>
                      <th>Advisories</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortBySeverity(proj.vulnerabilities).map((v, j) => (
                      <tr key={j}>
                        <td><SeverityBadge severity={v.severity} /></td>
                        <td><code>{v.package}</code></td>
                        <td>{v.isDirect ? "yes" : "transitive"}</td>
                        <td>{v.fixAvailable === true ? "yes" : v.fixAvailable || "no"}</td>
                        <td>
                          <ul className="advisory-list">
                            {v.via.map((advisory, k) => (
                              <li key={k}>
                                {advisory.url ? (
                                  <a href={advisory.url} target="_blank" rel="noreferrer">
                                    {advisory.title}
                                  </a>
                                ) : (
                                  advisory.title
                                )}
                              </li>
                            ))}
                          </ul>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ))}
        </>
      )}
    </section>
  );
}
