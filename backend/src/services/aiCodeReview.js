import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCodebaseAgent, AGENT_MODEL } from "./claudeAgent.js";
import { isBenignScanPath } from "./projectProfile.js";

// Per domain - the 3 domains below each get their own Claude Code session with this many turns.
const MAX_TURNS = Number(process.env.CLAUDE_REVIEW_MAX_TURNS || 60);
const MAX_BUDGET_USD = Number(process.env.CLAUDE_REVIEW_MAX_BUDGET_USD || 3);
// Beyond this many reachable files, the scope hint lists the first N and says so.
const MAX_SCOPE_FILES_IN_PROMPT = 300;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = path.join(__dirname, "..", "..", "prompts", "ai-review");

// Three independent domain reviewers, synced from an internal AI-plugin repo's kf-review-security,
// kf-review-maintainability and kf-review-caching-perf agents. Each explores the codebase cold and
// reports only within its own domain, so a finding's pillar is its domain (pillarClassify.js).
// Like the source project, each runs as a real Claude Code session (claudeAgent.js) rather than a
// direct API call - the rubric text lives verbatim in prompts/ai-review/<key>.md, and only the
// framing around it (who the reviewer is, which tools exist, what to return) is assembled here.
//
// Keep category lists in sync with the rubric headings in each prompt file, and with
// frontend/src/components/AiCodeReviewReport.jsx's DOMAIN_ORDER/CATEGORY_LABEL.
const DOMAINS = [
  {
    key: "security",
    label: "Security",
    reviewer: "a senior application security reviewer auditing a React frontend codebase",
    alreadyCaught:
      "ESLint, SonarQube, a gitleaks-class secret scanner (betterleaks), and npm audit - do NOT flag anything those tools would already catch: generic XSS lint rules, hardcoded secrets/credentials, known CVEs in dependency versions, syntax errors, or basic style issues.",
    job: "find security issues that require judgment, cross-file reasoning, or architectural/runtime awareness - things static analysis structurally cannot detect.",
    startWith:
      "read the files most likely to carry real risk (auth flows, API/data clients, storage/persistence, anything rendering user- or third-party-controlled content, routing/guards, WebSocket/postMessage handlers, package.json + lockfile)",
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
    severityHint: "how severe this is IF confirmed",
  },
  {
    key: "maintainability",
    label: "Maintainability",
    reviewer: "a senior engineer auditing a React codebase's long-term maintainability and architecture",
    alreadyCaught:
      "ESLint and SonarQube - do NOT flag anything those tools already catch: cyclomatic complexity thresholds, duplicate code blocks, unused variables/exports, naming conventions, long-file/long-function line-count thresholds, or basic style.",
    job: "find issues that require cross-file/cross-module reasoning or holistic understanding of the codebase's structure - things a per-file linter or per-file metric structurally cannot see.",
    startWith:
      "work out the project's overall shape and folder conventions (feature-sliced? domain folders? flat?), then read across several features/modules to find DIVERGENCE - the same kind of problem solved differently in different places - which is invisible to a linter that only ever sees one file at a time",
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
    severityHint: "how severe this is IF the finding is correct - weight by blast radius and how actively-edited the code looks",
  },
  {
    key: "caching-performance",
    label: "Caching & Performance",
    reviewer: "a senior performance engineer auditing a React codebase for caching and runtime-performance issues",
    alreadyCaught:
      "ESLint (including react-hooks/exhaustive-deps) and SonarQube - do NOT flag anything those tools already catch.",
    job: "find issues that require judgment, runtime awareness, or cross-file/system-level reasoning - things static linters structurally cannot detect.",
    startWith:
      "read data-fetching hooks/clients, state stores, and the largest/most-rendered list or dashboard components",
    categories: [
      "rendering_performance",
      "api_call_patterns",
      "caching_correctness",
      "request_lifecycle_resilience",
      "state_management_performance",
      "bundle_build_performance",
    ],
    severityHint:
      "a missing cache-key scope (cross-tenant/user data leak) or a request race that corrupts displayed state is critical/high regardless of confidence tier; a speculative bundle-size question is rarely above medium",
  },
];

const SEVERITIES = ["critical", "high", "medium", "low"];
const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };
const EVIDENCE_STATUSES = ["confirmed", "insufficient-evidence", "review-required"];

const RUBRICS = Object.fromEntries(
  DOMAINS.map((d) => [d.key, fs.readFileSync(path.join(PROMPTS_DIR, `${d.key}.md`), "utf8").trim()])
);

function outputSchema(domain) {
  return {
    type: "object",
    properties: {
      findings: {
        type: "array",
        items: {
          type: "object",
          properties: {
            occurrences: {
              type: "array",
              minItems: 1,
              description:
                "Every location this one finding covers. Most findings have exactly one. Give more than one only when the locations share the same root cause or are tightly coupled - see the merging rule in the instructions.",
              items: {
                type: "object",
                properties: {
                  file: { type: "string", description: "File path relative to the codebase root" },
                  line: { type: ["integer", "null"], description: "Line number, or null if the issue isn't tied to one specific line" },
                },
                required: ["file", "line"],
              },
            },
            category: { type: "string", enum: domain.categories },
            severity: { type: "string", enum: SEVERITIES, description: domain.severityHint },
            summary: { type: "string", description: "One or two sentences: what the defect is, citing the specific pattern/locations" },
            impact: { type: "string", description: "Why it matters, as a concrete failure scenario - not generic best-practice language" },
            fix: { type: "string", description: "A concrete, actionable fix or alternative approach" },
            evidenceStatus: { type: "string", enum: EVIDENCE_STATUSES },
            requiredEvidence: {
              type: ["string", "null"],
              description: "Null when evidenceStatus is 'confirmed'; otherwise the exact test/trace/decision that would settle it.",
            },
          },
          required: ["occurrences", "category", "severity", "summary", "impact", "fix", "evidenceStatus", "requiredEvidence"],
        },
      },
    },
    required: ["findings"],
  };
}

/** What the reviewer should assume about the codebase, per scan profile (see projectProfile.js). */
function codebaseContext(scope) {
  if (scope?.profile !== "kissflow-starter") {
    return "Where the codebase has TypeScript files, `tsc --noEmit` also runs - do not flag type errors either.";
  }
  let text =
    "This codebase is a Kissflow custom-UI app built on the Kissflow starter scaffold: plain JS/JSX with no type checker running - don't assume any type-safety net exists. " +
    "Data access and the user session go through the Kissflow SDK (`useKf()`, `kf.api`, `kf.app`), which owns auth - the app is not expected to handle tokens itself. " +
    "`src/components/kit/**`, `src/components/ui/**` and `src/components/legacy/**` are pre-built framework code, not authored by the app.";
  if (scope.files?.length) {
    const listed = scope.files.slice(0, MAX_SCOPE_FILES_IN_PROMPT);
    text +=
      `\n\nOnly these ${scope.files.length} file(s) are actually reachable from the app's entry points - concentrate your review on them, and never report a framework file that isn't in this list (it is unused, not dead code to flag):\n` +
      listed.map((f) => `- ${f}`).join("\n") +
      (scope.files.length > listed.length ? `\n- … and ${scope.files.length - listed.length} more` : "");
  }
  return text;
}

function buildPrompt(domain, scope) {
  return `You are ${domain.reviewer}. This codebase already runs ${domain.alreadyCaught} Assume all of the above is clean. Your job is to ${domain.job}

${codebaseContext(scope)}

The codebase is already extracted to your current working directory and you have read-only access to it (Read, Grep, Glob - no shell, no writing, no network). Start by getting a feel for the project's shape, then ${domain.startWith} before deciding what's worth flagging. You have a limited number of turns - when you need to read or search several independent things, request them all in the same turn rather than one at a time.

\`.env\`/\`.env.*\` files (except \`.env.example\`) and anything under \`cert/\` are out of scope: a correctly-placed credential in \`.env\` is the secret scanner's job, and \`cert/\` holds a local-dev certificate. The tools will not open them, and findings pointing at them are discarded.

${RUBRICS[domain.key]}

When you have covered every dimension worth covering, return your findings as JSON matching the required schema - one entry per finding, or an empty array if there is genuinely nothing to report. Severity is one of ${SEVERITIES.join(" | ")}. "requiredEvidence" is null when evidenceStatus is "confirmed". Do not fabricate code you did not read.`;
}

/**
 * Tags each finding with its domain, normalizes severity, and drops occurrences on known-benign
 * paths (.env, cert/) - the mechanical backstop for the prompt's out-of-scope rule, same as the
 * source project's `filter-benign` step. A finding left with no occurrences is dropped.
 */
function normalizeFindings(domain, raw, scope) {
  const findings = [];
  for (const f of raw || []) {
    const occurrences = (f.occurrences || []).filter((o) => !isBenignScanPath(o.file, scope));
    if (occurrences.length === 0) continue;
    findings.push({ ...f, domain: domain.key, severity: String(f.severity || "medium").toLowerCase(), occurrences });
  }
  return findings;
}

/** One domain's own Claude Code session, exploring the codebase cold. */
async function runDomainReview(domain, scan, scope, onEvent, signal) {
  const { structured, costUsd, numTurns } = await runCodebaseAgent({
    extractDir: scan.extractDir,
    scope,
    prompt: buildPrompt(domain, scope),
    schema: outputSchema(domain),
    onEvent,
    signal,
    maxTurns: MAX_TURNS,
    maxBudgetUsd: MAX_BUDGET_USD,
    label: `[${domain.label}]`,
  });

  const findings = normalizeFindings(domain, structured.findings, scope);
  onEvent({ type: "summary", text: `[${domain.label}] Done - ${findings.length} finding(s)` });
  return { findings, costUsd, numTurns };
}

/**
 * Runs the 3 domain reviewers in parallel and merges their findings. One domain failing doesn't
 * discard the others - it's recorded in domainErrors, which healthScore.js treats as an
 * incomplete scan rather than a clean one. Only if every domain fails does the stage fail.
 */
export async function runAiCodeReview(scan, onEvent = () => {}, signal, scope) {
  onEvent({ type: "status", text: `Starting AI code review (${DOMAINS.map((d) => d.label).join(", ")}) in parallel...` });

  const settled = await Promise.allSettled(DOMAINS.map((d) => runDomainReview(d, scan, scope, onEvent, signal)));

  const aborted = settled.find((s) => s.status === "rejected" && s.reason?.name === "AbortError");
  if (aborted) throw aborted.reason;

  const findings = [];
  const domains = [];
  const domainErrors = [];
  let totalCostUsd = 0;

  settled.forEach((s, i) => {
    const domain = DOMAINS[i];
    if (s.status === "rejected") {
      domainErrors.push({ domain: domain.key, error: s.reason?.message || String(s.reason) });
      domains.push({ key: domain.key, label: domain.label, findingCount: 0, error: s.reason?.message || String(s.reason) });
      onEvent({ type: "status", text: `[${domain.label}] Failed: ${s.reason?.message || s.reason}` });
      return;
    }
    findings.push(...s.value.findings);
    totalCostUsd += s.value.costUsd || 0;
    domains.push({
      key: domain.key,
      label: domain.label,
      findingCount: s.value.findings.length,
      costUsd: s.value.costUsd,
      numTurns: s.value.numTurns,
    });
  });

  if (domainErrors.length === DOMAINS.length) {
    throw new Error(`Every AI review domain failed: ${domainErrors.map((d) => `${d.domain}: ${d.error}`).join("; ")}`);
  }

  findings.sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9));
  onEvent({ type: "status", text: `Done - ${findings.length} finding(s)${domainErrors.length ? `, ${domainErrors.length} domain(s) failed` : ""}` });

  return {
    tool: "ai-code-review",
    model: AGENT_MODEL,
    scannedAt: new Date().toISOString(),
    domains,
    domainErrors,
    findings,
    totalCostUsd,
  };
}
