// Shared by ExplainReport.jsx and HealthScore.jsx's issue modals - one
// payload shape for "another AI/tool can apply this fix with no further
// investigation," regardless of which screen the copy button lives on.
export function toAgentPayload(g) {
  return {
    title: g.title,
    severity: g.severity,
    fixType: g.fixType,
    find: g.find,
    replace: g.replace,
    instructions: g.agentInstructions,
    occurrences: g.occurrences,
  };
}
