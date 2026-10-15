// Turns raw findings from all four scan stages into a single 0-100 "codebase
// health" score, broken into three customer-facing pillars: Security,
// Reliability, Maintainability. Two rules matter more than the arithmetic:
//
// 1. Diminishing returns: point cost per bucket is weight * sqrt(count), not
//    weight * count, so a pile of minor findings can't swamp the score the
//    way a flat sum would.
// 2. Hard severity cap: any SERIOUS finding in a pillar caps that pillar's
//    score at 39 (any MAJOR caps at 69), applied AFTER the arithmetic, so a
//    single real risk can never get "averaged away" by an otherwise-clean
//    codebase. This is what makes the number trustworthy rather than just a
//    vibe.

import {
  classifySecret,
  classifyDependency,
  classifySonarIssue,
  classifySonarHotspot,
  classifyCodeQuality,
  classifyAiReview,
} from "./pillarClassify.js";

const BUCKET_WEIGHT = { SERIOUS: 25, MAJOR: 12, MINOR: 4, TINY: 1 };
const BUCKET_CAP = { SERIOUS: 39, MAJOR: 69 };
const PILLAR_WEIGHT = { security: 0.5, reliability: 0.3, maintainability: 0.2 };

const SOURCE_LABEL = {
  secret: "exposed secret",
  dependency: "vulnerable dependency",
  bug: "bug",
  vulnerability: "security issue",
  hotspot: "security hotspot",
  codeSmell: "code smell",
  codeStandards: "code standards issue",
  typeSafety: "type error",
  suppressedCheck: "suppressed lint check",
  styling: "styling issue",
  aiReview: "AI-flagged issue",
};

/** Collects every finding across the four stages into { pillar, bucket, source } items. */
function collectItems(scan) {
  const items = [];
  const results = scan.results || {};

  const secrets = results.secrets;
  if (secrets?.findings) {
    for (const _ of secrets.findings) items.push(classifySecret());
  }

  const deps = results.dependencies;
  if (deps?.projects) {
    for (const proj of deps.projects) {
      if (!proj.ok) continue;
      for (const v of proj.vulnerabilities) items.push(classifyDependency(v.severity));
    }
  }

  const sonar = results.sonar;
  if (sonar?.issues) {
    for (const i of sonar.issues) items.push(classifySonarIssue(i.type, i.severity));
  }
  if (sonar?.securityHotspots) {
    for (const h of sonar.securityHotspots) items.push(classifySonarHotspot(h.vulnerabilityProbability));
  }

  const codeQuality = results.codeQuality;
  if (codeQuality?.findings) {
    for (const f of codeQuality.findings) items.push(classifyCodeQuality(f.tool, f.severity));
  }

  const aiReview = results.aiCodeReview;
  if (aiReview?.findings) {
    // Only findings the review could confirm from the source alone count
    // toward the score - an "insufficient-evidence"/"review-required"
    // candidate is a real lead worth showing, but scoring it would penalize
    // the codebase for something not yet proven. Old scans predating the
    // evidenceStatus field have no such field at all, so they default to
    // "confirmed" rather than silently losing their score contribution.
    for (const f of aiReview.findings) {
      if ((f.evidenceStatus || "confirmed") === "confirmed") items.push(classifyAiReview(f));
    }
  }

  return items;
}

// 80 is the product's stated bar for "healthy" (shown to the user as such) -
// keep this in sync with that copy rather than picking a separate number.
function scoreLabel(score) {
  if (score >= 80) return "Healthy";
  if (score >= 60) return "Needs Attention";
  if (score >= 30) return "Poor";
  return "Critical";
}

/** weight * sqrt(count) per bucket, summed, then clamped and hard-capped. */
function scorePillar(pillarItems) {
  const counts = { SERIOUS: 0, MAJOR: 0, MINOR: 0, TINY: 0 };
  const bySource = new Map();
  for (const item of pillarItems) {
    counts[item.bucket] += 1;
    bySource.set(item.source, (bySource.get(item.source) || 0) + 1);
  }

  let deduction = 0;
  for (const bucket of Object.keys(BUCKET_WEIGHT)) {
    if (counts[bucket] > 0) deduction += BUCKET_WEIGHT[bucket] * Math.sqrt(counts[bucket]);
  }

  let score = Math.max(0, Math.min(100, 100 - deduction));

  let cappedAt = null;
  if (counts.SERIOUS > 0) cappedAt = BUCKET_CAP.SERIOUS;
  else if (counts.MAJOR > 0) cappedAt = BUCKET_CAP.MAJOR;
  if (cappedAt !== null && score > cappedAt) score = cappedAt;

  // Human-readable "what's dragging this down" - worst bucket's sources first.
  const worstBucket = ["SERIOUS", "MAJOR", "MINOR", "TINY"].find((b) => counts[b] > 0) || null;
  const topIssues = [...bySource.entries()]
    .filter(([source]) => pillarItems.some((i) => i.source === source && i.bucket === worstBucket))
    .map(([source, count]) => ({ label: SOURCE_LABEL[source] || source, count }))
    .sort((a, b) => b.count - a.count);

  return {
    score: Math.round(score),
    label: scoreLabel(Math.round(score)),
    cappedAt,
    counts,
    topIssues,
  };
}

/**
 * Blends three pillar scores into the overall 0-100, then re-applies the same
 * hard-cap override across every item (not just one pillar's) - see the note
 * on computeHealthScore below for why the per-pillar cap alone isn't enough.
 */
function computeOverall(pillars, items) {
  let overall = Math.round(
    pillars.security.score * PILLAR_WEIGHT.security +
      pillars.reliability.score * PILLAR_WEIGHT.reliability +
      pillars.maintainability.score * PILLAR_WEIGHT.maintainability
  );
  if (items.some((i) => i.bucket === "SERIOUS")) overall = Math.min(overall, BUCKET_CAP.SERIOUS);
  else if (items.some((i) => i.bucket === "MAJOR")) overall = Math.min(overall, BUCKET_CAP.MAJOR);
  return overall;
}

const CLEAN_PILLAR = {
  score: 100,
  label: scoreLabel(100),
  cappedAt: null,
  counts: { SERIOUS: 0, MAJOR: 0, MINOR: 0, TINY: 0 },
  topIssues: [],
};

/**
 * Every stage (or tool within a stage) that failed to produce results. A
 * failed stage contributes zero findings, which would otherwise make the
 * score look BETTER than the codebase is - so a score built on one is
 * labelled "Incomplete" rather than passed off as a real verdict. This is
 * the fail-closed rule the ai-plugin scan gate is missing: a missing
 * betterleaks binary or unreachable Sonar must not read as "clean".
 */
function findIncompleteStages(scan) {
  const incomplete = [];
  for (const [stage, status] of Object.entries(scan.stageStatus || {})) {
    if (status === "error" && stage !== "explanations") incomplete.push({ stage, reason: `${stage} stage failed` });
  }
  const r = scan.results || {};
  for (const proj of r.dependencies?.projects || []) {
    if (!proj.ok) incomplete.push({ stage: "dependencies", reason: `npm audit failed in ${proj.dir}` });
  }
  for (const tool of ["eslint", "stylelint", "typescript"]) {
    if (r.codeQuality?.[tool]?.error) incomplete.push({ stage: "codeQuality", reason: `${tool} failed` });
  }
  if (r.sonar?.issuesError) incomplete.push({ stage: "sonar", reason: "could not read Sonar issues" });
  for (const d of r.aiCodeReview?.domainErrors || []) {
    incomplete.push({ stage: "aiCodeReview", reason: `${d.domain} review failed` });
  }
  return incomplete;
}

/**
 * Computes a 0-100 codebase health score from whatever scan stages have
 * results so far (missing stages just contribute nothing - safe to call
 * before every stage has finished).
 */
export function computeHealthScore(scan) {
  const items = collectItems(scan);

  const security = scorePillar(items.filter((i) => i.pillar === "security"));
  const reliability = scorePillar(items.filter((i) => i.pillar === "reliability"));
  const maintainability = scorePillar(items.filter((i) => i.pillar === "maintainability"));
  const pillars = { security, reliability, maintainability };

  // The per-pillar cap alone isn't enough: a bad Security pillar blended with
  // two clean pillars can still average back up into "healthy" territory,
  // which is exactly the "one serious issue gets averaged away" failure mode
  // this whole scheme exists to prevent. So the same override applies again
  // here, driven by every item across all pillars, not just one pillar's.
  const overall = computeOverall(pillars, items);

  // "Fix every Security issue and your score becomes N" - a real
  // recomputation with that pillar's items removed, not a linear estimate.
  // The sqrt-based deduction and the hard cap both mean fixing findings isn't
  // linear - clearing the one SERIOUS item in a pillar can lift its score far
  // more than the arithmetic alone suggests, so only an actual rerun is honest.
  const whatIf = {};
  for (const key of ["security", "reliability", "maintainability"]) {
    const remainingItems = items.filter((i) => i.pillar !== key);
    whatIf[key] = computeOverall({ ...pillars, [key]: CLEAN_PILLAR }, remainingItems);
  }

  const incompleteStages = findIncompleteStages(scan);

  return {
    overall,
    label: incompleteStages.length > 0 ? "Incomplete" : scoreLabel(overall),
    incompleteStages,
    totalFindings: items.length,
    scannedAt: new Date().toISOString(),
    pillars,
    whatIf,
  };
}
