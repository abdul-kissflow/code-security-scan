import { useEffect, useRef } from "react";
import SeverityBadge from "./SeverityBadge.jsx";
import CopyJsonButton from "./CopyJsonButton.jsx";
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

// Same domains, order and category keys as backend/src/services/aiCodeReview.js's DOMAINS - kept
// in sync so "grouped by area, then category, ranked by severity within" matches the rubrics.
const DOMAIN_ORDER = [
  {
    key: "security",
    label: "Security",
    categories: [
      "authorization",
      "injection_unsafe_sinks",
      "sensitive_data_exposure",
      "auth_token_handling",
      "csrf_cors_postmessage",
      "client_crypto_randomness",
      "websocket_realtime",
      "supply_chain_beyond_cves",
    ],
  },
  {
    key: "caching-performance",
    label: "Caching & Performance",
    categories: [
      "rendering_performance",
      "api_call_patterns",
      "caching_correctness",
      "request_lifecycle_resilience",
      "state_management_performance",
      "bundle_build_performance",
    ],
  },
  {
    key: "maintainability",
    label: "Maintainability",
    categories: [
      "architectural_layering",
      "coupling_cohesion",
      "inconsistent_patterns",
      "god_components_hooks",
      "prop_drilling_context",
      "api_design_smells",
      "domain_logic_in_view",
      "over_under_abstraction",
      "dead_architecture",
      "design_system_drift",
      "test_coupling",
    ],
  },
  // Scans run before the 3-domain split: one reviewer, no `domain` on its findings.
  {
    key: null,
    label: "Earlier review",
    categories: [
      "functional_correctness",
      "authorization",
      "security_context",
      "api_call_quality",
      "request_lifecycle",
      "caching_state",
      "state_management",
      "privacy",
      "accessibility",
      "dependency_supply_chain",
      "hygiene",
    ],
  },
];
const CATEGORY_LABEL = {
  authorization: "Authorization & Access Control",
  injection_unsafe_sinks: "Injection & Unsafe Sinks",
  sensitive_data_exposure: "Sensitive Data Exposure",
  auth_token_handling: "Auth Token Handling",
  csrf_cors_postmessage: "CSRF, CORS & postMessage",
  client_crypto_randomness: "Client-Side Crypto & Randomness",
  websocket_realtime: "WebSocket / Realtime",
  supply_chain_beyond_cves: "Supply Chain Beyond Known CVEs",
  rendering_performance: "Rendering Performance",
  api_call_patterns: "API Call Patterns & Request Topology",
  caching_correctness: "Caching Correctness",
  request_lifecycle_resilience: "Request Lifecycle & Resilience",
  state_management_performance: "State Management Performance",
  bundle_build_performance: "Bundle & Build Performance",
  architectural_layering: "Architectural Layering",
  coupling_cohesion: "Coupling & Cohesion",
  inconsistent_patterns: "Inconsistent Patterns",
  god_components_hooks: "God Components & Hooks",
  prop_drilling_context: "Prop Drilling vs. Context",
  api_design_smells: "Component & Hook API Design",
  domain_logic_in_view: "Domain Logic in the View Layer",
  over_under_abstraction: "Over- & Under-Abstraction",
  dead_architecture: "Dead Architecture",
  design_system_drift: "Design-System Drift",
  test_coupling: "Test-to-Code Coupling",
  functional_correctness: "Functional & Business Correctness",
  security_context: "Input Handling & Injection Risk",
  api_call_quality: "API Call Quality & Request Topology",
  request_lifecycle: "Request Lifecycle & Resilience",
  caching_state: "Caching & State Consistency",
  state_management: "State Management & Component Behavior",
  privacy: "Privacy & Data Handling",
  accessibility: "Accessibility",
  dependency_supply_chain: "Dependency & Supply-Chain Risk",
  hygiene: "Cross-Cutting Hygiene",
};

const EVIDENCE_LABEL = {
  "insufficient-evidence": "Needs runtime verification",
  "review-required": "Needs a policy/business decision",
};

// Matches the shape backend/src/services/fastExplainer.js's aiFindingToGroup
// maps these same findings into for the Final Report, so "copy as JSON"
// produces the identical automation payload wherever a finding appears -
// including the unconfirmed-finding caveat, so an automated agent copying
// this JSON doesn't blindly apply a fix that hasn't actually been verified.
function toGroupShape(f) {
  const unconfirmed = f.evidenceStatus && f.evidenceStatus !== "confirmed";
  return {
    title: unconfirmed ? `[Needs verification] ${f.summary}` : f.summary,
    severity: f.severity,
    fixType: f.occurrences.length > 1 ? "pattern_all_occurrences" : "single_location",
    find: null,
    replace: null,
    agentInstructions: unconfirmed
      ? `${f.fix} (Not yet confirmed - first verify: ${f.requiredEvidence || "runtime/manual confirmation needed"}.)`
      : f.fix,
    occurrences: f.occurrences,
  };
}

function FindingCard({ f }) {
  const unconfirmed = f.evidenceStatus && f.evidenceStatus !== "confirmed";
  return (
    <div className="explain-group">
      <div className="explain-group-header">
        <SeverityBadge severity={f.severity} />
        <h3>{f.summary}</h3>
        {unconfirmed && <span className="evidence-tag">{EVIDENCE_LABEL[f.evidenceStatus] || f.evidenceStatus}</span>}
      </div>
      <dl className="explain-dl">
        <dt>Impact</dt>
        <dd>{f.impact}</dd>
        <dt>Fix</dt>
        <dd>{f.fix}</dd>
      </dl>
      {unconfirmed && f.requiredEvidence && (
        <p className="required-evidence">
          <strong>To confirm:</strong> {f.requiredEvidence}
        </p>
      )}
      <details>
        <summary>{f.occurrences.length} location{f.occurrences.length === 1 ? "" : "s"}</summary>
        <ul className="advisory-list">
          {f.occurrences.map((o, j) => (
            <li key={j}><code>{o.file}{o.line ? `:${o.line}` : ""}</code></li>
          ))}
        </ul>
      </details>
    </div>
  );
}

export default function AiCodeReviewReport({ state }) {
  if (state.status === "idle") return null;

  return (
    <section className="report-card">
      <header className="report-header">
        <h2>AI Code Review</h2>
      </header>

      <p className="muted">
        Three senior-reviewer passes run in parallel — security, caching &amp; performance, and
        maintainability — looking for judgment-level issues static analysis structurally can't catch. Confirmed findings feed the Final Report and the health score
        directly; findings tagged "needs verification" are real leads that still need a runtime test or a
        product decision before they count.
      </p>

      {state.status === "running" && (
        <>
          <p className="muted">Reviewing your codebase — this can take a little while for larger codebases.</p>
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
          <div className="summary-line-row">
            <p className="summary-line">
              {state.data.findings.length} finding{state.data.findings.length === 1 ? "" : "s"}
              {(() => {
                const needsVerification = state.data.findings.filter((f) => f.evidenceStatus && f.evidenceStatus !== "confirmed").length;
                return needsVerification > 0 ? (
                  <span className="muted"> · {needsVerification} need{needsVerification === 1 ? "s" : ""} verification</span>
                ) : null;
              })()}
            </p>
            {state.data.findings.length > 0 && <CopyJsonButton groups={state.data.findings.map(toGroupShape)} />}
          </div>

          {state.log?.length > 0 && (
            <details>
              <summary>Show run log ({state.log.length} events)</summary>
              <LiveLog log={state.log} />
            </details>
          )}

          {state.data.domainErrors?.length > 0 && (
            <p className="warn-text">
              Review failed for: {state.data.domainErrors.map((d) => `${d.domain} (${d.error})`).join("; ")}. Those
              areas weren't reviewed, so the health score is marked incomplete.
            </p>
          )}

          {state.data.findings.length === 0 && <p className="ok-text">No findings.</p>}

          {DOMAIN_ORDER.map((domain) => {
            const domainFindings = state.data.findings.filter((f) => (f.domain || null) === domain.key);
            if (domainFindings.length === 0) return null;
            return (
              <div key={domain.label}>
                <h3 className="health-section-heading">
                  {domain.label} ({domainFindings.length})
                </h3>
                {domain.categories.map((cat) => {
                  const items = sortBySeverity(domainFindings.filter((f) => f.category === cat));
                  if (items.length === 0) return null;
                  return (
                    <div key={cat}>
                      <h4 className="review-category-heading">
                        {CATEGORY_LABEL[cat]} ({items.length})
                      </h4>
                      {items.map((f, i) => (
                        <FindingCard key={i} f={f} />
                      ))}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </>
      )}
    </section>
  );
}
