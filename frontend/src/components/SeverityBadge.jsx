const CLASS_BY_SEVERITY = {
  // npm audit / betterleaks severities
  critical: "badge badge-critical",
  high: "badge badge-high",
  moderate: "badge badge-moderate",
  medium: "badge badge-moderate",
  low: "badge badge-low",
  info: "badge badge-info",
  // classic SonarQube issue severities
  blocker: "badge badge-critical",
  major: "badge badge-high",
  minor: "badge badge-low",
  // unified health-score buckets (see backend/src/services/healthScore.js)
  serious: "badge badge-critical",
  tiny: "badge badge-info",
};

export default function SeverityBadge({ severity }) {
  if (!severity) return null;
  const key = String(severity).toLowerCase();
  return <span className={CLASS_BY_SEVERITY[key] || "badge"}>{severity}</span>;
}
