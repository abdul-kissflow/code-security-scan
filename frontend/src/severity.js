// Single ranking for every severity vocabulary used across the report tabs
// (betterleaks/npm-audit: critical/high/moderate/low/info; classic
// SonarQube: BLOCKER/CRITICAL/MAJOR/MINOR/INFO, hotspot probability:
// HIGH/MEDIUM/LOW; eslint/tsc/stylelint + the AI review + Final Report
// groups: critical/high/medium/low) - so "sort by priority" means the same
// thing everywhere instead of every table inventing its own order.
const NORMALIZE = { blocker: "critical", major: "medium", minor: "low", moderate: "medium" };
const RANK = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

export function severityRank(severity) {
  if (!severity) return 9;
  const key = String(severity).toLowerCase();
  return RANK[NORMALIZE[key] || key] ?? 9;
}

/** Returns a new array sorted most-severe first; does not mutate the input. */
export function sortBySeverity(items, getSeverity = (item) => item.severity) {
  return [...items].sort((a, b) => severityRank(getSeverity(a)) - severityRank(getSeverity(b)));
}
