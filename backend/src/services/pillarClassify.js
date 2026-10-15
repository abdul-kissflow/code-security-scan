// Single source of truth for "which pillar (security/reliability/maintainability)
// and severity bucket does this finding belong to" - used by healthScore.js to
// compute the score AND by findings.js to tag findings for the AI explain
// stage, so a Security finding is always classified as Security in both
// places. Previously these were two separate hand-maintained mappings that
// had to be kept in sync by convention; this removes that risk.

const DEP_SEVERITY_TO_BUCKET = { critical: "SERIOUS", high: "MAJOR", moderate: "MINOR", low: "TINY", info: "TINY" };
const SONAR_SEVERITY_TO_BUCKET = { BLOCKER: "SERIOUS", CRITICAL: "SERIOUS", MAJOR: "MAJOR", MINOR: "MINOR", INFO: "TINY" };
const SONAR_HOTSPOT_PROBABILITY_TO_BUCKET = { HIGH: "MAJOR", MEDIUM: "MINOR", LOW: "TINY" };
const CQ_SEVERITY_TO_BUCKET = { critical: "SERIOUS", high: "MAJOR", medium: "MINOR", low: "TINY", info: "TINY" };
const AI_REVIEW_SEVERITY_TO_BUCKET = { critical: "SERIOUS", high: "MAJOR", medium: "MINOR", low: "TINY" };

// The AI review runs as 3 domain reviewers (see aiCodeReview.js), each only
// reporting within its own pillar's territory, so a finding's pillar is its
// domain - same mapping as the ai-plugin scan-engine.
const AI_REVIEW_DOMAIN_TO_PILLAR = {
  security: "security",
  maintainability: "maintainability",
  "caching-performance": "reliability",
};

// LEGACY: scans run before the 3-domain split carry only a category from the
// single-reviewer rubric. Kept so those stored results still score the same.
// The old AI review agent's rubric dimensions mapped onto
// the same 3 pillars the score already uses. Anything about a live risk to
// data or access maps to security; anything about runtime behavior actually
// breaking (races, request handling, staleness) maps to reliability;
// anything about the code's long-term shape (ownership, structure, hygiene)
// maps to maintainability. Unknown/old category values (from scans run
// before this taxonomy) fall back to maintainability rather than erroring.
const AI_REVIEW_CATEGORY_TO_PILLAR = {
  functional_correctness: "reliability",
  authorization: "security",
  security_context: "security",
  api_call_quality: "reliability",
  request_lifecycle: "reliability",
  caching_state: "reliability",
  state_management: "maintainability",
  privacy: "security",
  accessibility: "maintainability",
  dependency_supply_chain: "security",
  hygiene: "maintainability",
};

export function classifySecret() {
  return { pillar: "security", bucket: "SERIOUS", source: "secret" };
}

export function classifyDependency(severity) {
  return { pillar: "security", bucket: DEP_SEVERITY_TO_BUCKET[severity] || "MINOR", source: "dependency" };
}

export function classifySonarIssue(type, severity) {
  const bucket = SONAR_SEVERITY_TO_BUCKET[severity] || "MINOR";
  if (type === "BUG") return { pillar: "reliability", bucket, source: "bug" };
  if (type === "VULNERABILITY") return { pillar: "security", bucket, source: "vulnerability" };
  return { pillar: "maintainability", bucket, source: "codeSmell" };
}

export function classifySonarHotspot(probability) {
  return { pillar: "security", bucket: SONAR_HOTSPOT_PROBABILITY_TO_BUCKET[probability] || "MINOR", source: "hotspot" };
}

export function classifyCodeQuality(tool, severity) {
  const bucket = CQ_SEVERITY_TO_BUCKET[severity] || "MINOR";
  if (tool === "eslint" && severity === "critical") return { pillar: "security", bucket, source: "vulnerability" };
  if (tool === "typescript") return { pillar: "reliability", bucket, source: "typeSafety" };
  if (tool === "stylelint") return { pillar: "maintainability", bucket, source: "styling" };
  // A disabled lint check is a hidden finding, not a clean file - MAJOR, same as ai-plugin's gate.
  if (tool === "suppression") return { pillar: "maintainability", bucket: "MAJOR", source: "suppressedCheck" };
  return { pillar: "maintainability", bucket, source: "codeStandards" };
}

export function classifyAiReview({ domain, category, severity }) {
  return {
    pillar: AI_REVIEW_DOMAIN_TO_PILLAR[domain] || AI_REVIEW_CATEGORY_TO_PILLAR[category] || "maintainability",
    bucket: AI_REVIEW_SEVERITY_TO_BUCKET[severity] || "MINOR",
    source: "aiReview",
  };
}
