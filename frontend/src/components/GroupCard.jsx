import SeverityBadge from "./SeverityBadge.jsx";
import { sourceLabel } from "../toolLabels.js";
import { CopyGroupJsonButton } from "./CopyJsonButton.jsx";

const FIX_TYPE_LABEL = {
  single_location: "One change fixes this",
  pattern_all_occurrences: "Same fix at every occurrence",
  manual_per_occurrence: "Needs case-by-case judgment",
};

/**
 * The full detail card for one Final Report group - what/why/fix, the
 * fix-type badge, the find/replace diff, agent instructions, and every
 * occurrence. Shared between the Final Report tab and the Code Health
 * modals so a group reads identically wherever it's shown, instead of the
 * modal getting a stripped-down summary of the same data.
 */
export default function GroupCard({ group: g }) {
  return (
    <div className="explain-group">
      <div className="explain-group-header">
        <SeverityBadge severity={g.severity} />
        <h3>{g.title}</h3>
        {g.sourceTools?.map((t) => (
          <span key={t} className="tool-tag">{sourceLabel(t)}</span>
        ))}
      </div>

      <dl className="explain-dl">
        <dt>What</dt>
        <dd>{g.issue}</dd>
        <dt>Why it matters</dt>
        <dd>{g.why}</dd>
        <dt>Suggested fix</dt>
        <dd>{g.fixSummary}</dd>
      </dl>

      <div className="agent-fix">
        <div className="agent-fix-header">
          <span className={`fix-type-badge fix-type-${g.fixType}`}>
            {FIX_TYPE_LABEL[g.fixType] || g.fixType}
          </span>
          <CopyGroupJsonButton group={g} />
        </div>

        {g.find && (
          <div className="fix-diff">
            <div className="fix-diff-remove">
              <span className="fix-diff-label">− find</span>
              <pre>{g.find}</pre>
            </div>
            <div className="fix-diff-add">
              <span className="fix-diff-label">+ replace</span>
              <pre>{g.replace}</pre>
            </div>
          </div>
        )}

        {g.agentInstructions && (
          <p className="agent-instructions">
            <strong>For automated tooling:</strong> {g.agentInstructions}
          </p>
        )}
      </div>

      <details>
        <summary>{g.occurrences.length} occurrence{g.occurrences.length === 1 ? "" : "s"}</summary>
        <ul className="advisory-list">
          {g.occurrences.map((o, j) => (
            <li key={j}><code>{o.file}{o.line ? `:${o.line}` : ""}</code></li>
          ))}
        </ul>
      </details>
    </div>
  );
}
