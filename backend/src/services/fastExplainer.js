import { flattenFindings } from "./findings.js";
import { classifyAiReview } from "./pillarClassify.js";
import { runCodebaseAgent, AGENT_MODEL } from "./claudeAgent.js";

const BATCH_SIZE = Number(process.env.CLAUDE_EXPLAIN_BATCH_SIZE || 8);
const CONCURRENCY = Number(process.env.CLAUDE_EXPLAIN_CONCURRENCY || 5);
const MAX_TURNS_PER_BATCH = Number(process.env.CLAUDE_EXPLAIN_MAX_TURNS_PER_BATCH || 14);
const MAX_BUDGET_USD_PER_BATCH = Number(process.env.CLAUDE_EXPLAIN_MAX_BUDGET_USD || 3);

const SEVERITY_RANK = { blocker: 0, critical: 1, high: 1, major: 2, medium: 2, minor: 3, low: 3, info: 4 };
function severityRank(s) {
  return SEVERITY_RANK[String(s).toLowerCase()] ?? 9;
}
function normalizeSeverity(s) {
  const key = String(s).toLowerCase();
  if (key === "blocker") return "critical";
  if (key === "major") return "medium";
  if (key === "minor") return "low";
  return ["critical", "high", "medium", "low", "info"].includes(key) ? key : "medium";
}

/** Groups pre-flattened findings by tool+rule (or tool+package) - pure JS, no LLM. This is
 * bookkeeping, not "reading code and deciding" - it just avoids asking the model to re-derive
 * something a Map already tells us for free. */
function groupFindings(items) {
  const map = new Map();
  for (const it of items) {
    const key = `${it.tool}::${it.rule}`;
    if (!map.has(key)) {
      map.set(key, {
        key,
        tool: it.tool,
        rule: it.rule,
        pillar: it.pillar,
        bucket: it.bucket,
        severity: normalizeSeverity(it.severity),
        occurrences: [],
      });
    }
    const g = map.get(key);
    g.occurrences.push({ file: it.file, line: it.line, message: it.message });
    if (severityRank(it.severity) < severityRank(g.severity)) g.severity = normalizeSeverity(it.severity);
  }
  return [...map.values()];
}

// The shape each batch's Claude Code session must return (outputFormat json_schema) - the same
// fields the hand-rolled submit_explanations tool used to take.
const BATCH_SCHEMA = {
      type: "object",
      properties: {
        groups: {
          type: "array",
          items: {
            type: "object",
            properties: {
              key: { type: "string", description: "Copy the group's key exactly" },
              title: { type: "string" },
              severity: { type: "string", enum: ["critical", "high", "medium", "low", "info"] },
              issue: { type: "string", description: "Human-readable: what the problem is" },
              why: { type: "string", description: "Human-readable: why it matters, grounded in the real code" },
              fixSummary: { type: "string", description: "Human-readable prose explanation of the fix" },
              fixType: {
                type: "string",
                enum: ["single_location", "pattern_all_occurrences", "manual_per_occurrence"],
                description:
                  "single_location: one change fixes the whole group (e.g. bump a version in package.json). " +
                  "pattern_all_occurrences: the exact same text transform applies at every occurrence listed. " +
                  "manual_per_occurrence: no safe blind patch exists - a human or agent must judge each occurrence individually.",
              },
              find: {
                type: ["string", "null"],
                description:
                  "For single_location/pattern_all_occurrences ONLY: the exact, verbatim existing code to locate (copy it character-for-character from what you read, including whitespace) - not a paraphrase or a regex. Null for manual_per_occurrence.",
              },
              replace: {
                type: ["string", "null"],
                description: "The exact replacement code for `find`. Null for manual_per_occurrence.",
              },
              agentInstructions: {
                type: "string",
                description:
                  "Imperative, self-contained instructions for another AI coding agent to apply this fix with no further investigation: which file(s), what to change, and any follow-up step (e.g. 'then run npm install'). For manual_per_occurrence, explain what judgment call is needed at each occurrence instead.",
              },
            },
            required: ["key", "title", "severity", "issue", "why", "fixSummary", "fixType", "find", "replace", "agentInstructions"],
          },
        },
      },
      required: ["groups"],
    };

function buildBatchPrompt(batch) {
  const payload = batch.map((g) => ({
    key: g.key,
    tool: g.tool,
    rule: g.rule,
    severity: g.severity,
    occurrenceCount: g.occurrences.length,
    files: [...new Set(g.occurrences.map((o) => o.file))].slice(0, 10),
    sampleLine: g.occurrences.find((o) => o.line)?.line ?? null,
    sampleMessage: g.occurrences[0]?.message,
  }));

  return `You are a code-reviewing agent explaining pre-grouped static-analysis findings from a frontend codebase, already extracted to disk. Each group below represents every occurrence of one rule/package.

The codebase is in your current working directory and you have read-only access to it (Read, Grep, Glob - no shell, no writing, no network). Use them to ground your explanation in what the code actually does - read at least the first occurrence's file for each group, and search further if the context is unclear or you need to see how something is used elsewhere. Findings that are self-evident from the rule/message alone (e.g. a known-CVE dependency version) don't need exploration - use your judgment. You have a limited number of turns: when you need to read or search multiple independent things, request them all in the same turn (multiple tool calls at once) rather than one at a time, so you don't run out of turns before every group is covered.

Groups (JSON):
${JSON.stringify(payload)}

Your output has two audiences: a human reading it in a dashboard, and another AI coding agent that will read your fixType/find/replace/agentInstructions fields and apply the fix with NO further investigation of its own - it will not re-read the file or re-derive context, so those fields must be self-sufficient and exact.

When you have enough context for every group, call submit_explanations exactly once with, for each group:
- "key": copied exactly
- "title", "severity": as before
- "issue", "why": human-readable prose, as before
- "fixSummary": human-readable prose explanation of the fix
- "fixType": "single_location" (one change fixes the whole group, e.g. a version bump in package.json), "pattern_all_occurrences" (the identical text transform applies at every occurrence you were given), or "manual_per_occurrence" (no safe blind patch exists - explain the judgment call needed instead)
- "find"/"replace": for single_location or pattern_all_occurrences, the EXACT verbatim code you actually read (character-for-character, correct whitespace) and its exact replacement - not a paraphrase, not a regex, not pseudocode. Copy it from the file. Null for manual_per_occurrence.
- "agentInstructions": imperative, self-contained steps another AI can follow blindly - which file(s) to touch and what to change, plus any required follow-up (e.g. "then run npm install"). For manual_per_occurrence, describe the per-occurrence judgment call instead of a blind patch.

Return one entry per group as JSON matching the required schema, covering every group you were given - a partial explanation for a group you couldn't fully explore is much better than omitting it. Do not fabricate code you did not read.`;
}

async function runBatchAgent(extractDir, scope, batch, batchLabel, onEvent, signal) {
  try {
    const { structured, costUsd } = await runCodebaseAgent({
      extractDir,
      scope,
      prompt: buildBatchPrompt(batch),
      schema: BATCH_SCHEMA,
      onEvent,
      signal,
      maxTurns: MAX_TURNS_PER_BATCH,
      maxBudgetUsd: MAX_BUDGET_USD_PER_BATCH,
      label: `${batchLabel}:`,
    });
    return { groups: structured.groups || [], costUsd: costUsd || 0 };
  } catch (err) {
    if (err?.name === "AbortError") throw err; // cancelling the scan cancels everything
    // One batch failing (turn cap, budget cap, a transient CLI error) must not throw away the
    // other batches' work: its groups fall through to the "couldn't finish this one" text below,
    // and the failure is recorded on the result so the score can be marked incomplete.
    onEvent({ type: "status", text: `${batchLabel}: failed - ${err.message}` });
    return { groups: [], costUsd: 0, error: err.message };
  }
}

async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function runner() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
  return results;
}

// AI Code Review (see aiCodeReview.js) findings arrive already categorized,
// with their own concrete fix and impact - re-running them through the
// grouping/explaining agent below would be redundant and risks the model
// paraphrasing a good fix into a worse one. They're mapped straight into the
// group shape instead and appended untouched, one finding per group (each
// already names exactly one file/line, so there's nothing to group further).
function aiFindingToGroup(f) {
  const { pillar, bucket } = classifyAiReview(f);
  const unconfirmed = f.evidenceStatus && f.evidenceStatus !== "confirmed";
  return {
    title: unconfirmed ? `[Needs verification] ${f.summary}` : f.summary,
    severity: f.severity,
    pillar,
    bucket,
    sourceTools: ["ai-code-review"],
    issue: f.summary,
    why: unconfirmed ? `${f.impact} (Not counted toward the score yet - ${f.requiredEvidence || "needs runtime/manual confirmation"}.)` : f.impact,
    fixSummary: f.fix,
    fixType: f.occurrences.length > 1 ? "pattern_all_occurrences" : "single_location",
    find: null,
    replace: null,
    agentInstructions: f.fix,
    occurrences: f.occurrences.map(({ file, line }) => ({ file, line: line ?? null })),
  };
}

/**
 * Our own tool-use agent - not the Claude Agent SDK / bundled "claude" CLI.
  * Findings are grouped in plain Node (free, instant), then each batch of
 * groups runs its OWN Claude Code session (claudeAgent.js - read-only Read/Grep/Glob, CLI auth,
 * no API key), so the model decides what to explore. Batches run concurrently, which one long
 * sequential session could not.
 */
export async function explainIssues(scan, onEvent = () => {}, signal, scope) {
  const items = flattenFindings(scan);
  const aiReviewFindings = scan.results.aiCodeReview?.findings || [];
  const aiGroups = aiReviewFindings.map(aiFindingToGroup);

  if (items.length === 0) {
    if (aiGroups.length > 0) {
      onEvent({ type: "status", text: `Adding ${aiGroups.length} AI code review finding(s) - already reviewed, no re-explaining needed` });
    }
    return {
      tool: "custom-agent",
      model: AGENT_MODEL,
      groups: aiGroups.sort((a, b) => severityRank(a.severity) - severityRank(b.severity)),
      findingsCount: aiReviewFindings.length,
      note: aiGroups.length === 0 ? "No findings to explain." : undefined,
    };
  }

  const groups = groupFindings(items);
  onEvent({ type: "status", text: `Grouped ${items.length} findings into ${groups.length} issue groups` });

  const batches = [];
  for (let i = 0; i < groups.length; i += BATCH_SIZE) batches.push(groups.slice(i, i + BATCH_SIZE));
  onEvent({
    type: "status",
    text: `Analyzing ${groups.length} issue groups, ${CONCURRENCY} at a time...`,
  });

  const byKey = new Map();
  const batchErrors = [];
  let totalCostUsd = 0;

  await runWithConcurrency(batches, CONCURRENCY, async (batch, i) => {
    const label = `Step ${i + 1}/${batches.length}`;
    onEvent({ type: "tool", text: `${label}: starting (${batch.length} groups)` });
    const result = await runBatchAgent(scan.extractDir, scope, batch, label, onEvent, signal);
    for (const explained of result.groups) byKey.set(explained.key, explained);
    if (result.error) batchErrors.push({ batch: label, error: result.error });
    totalCostUsd += result.costUsd;
  });

  const finalGroups = groups.map((g) => {
    const explained = byKey.get(g.key);
    return {
      title: explained?.title || g.rule,
      severity: explained?.severity || g.severity,
      pillar: g.pillar,
      bucket: g.bucket,
      sourceTools: [g.tool],
      issue: explained?.issue || "(this finding's explanation didn't finish - the finding itself is still real)",
      why: explained?.why || "",
      fixSummary: explained?.fixSummary || "",
      fixType: explained?.fixType || "manual_per_occurrence",
      find: explained?.find ?? null,
      replace: explained?.replace ?? null,
      agentInstructions: explained?.agentInstructions || "",
      occurrences: g.occurrences.map(({ file, line }) => ({ file, line })),
    };
  });

  if (aiGroups.length > 0) {
    onEvent({ type: "status", text: `Adding ${aiGroups.length} AI code review finding(s) - already reviewed, no re-explaining needed` });
  }
  const allGroups = [...finalGroups, ...aiGroups].sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
  onEvent({ type: "status", text: `Done - ${allGroups.length} groups explained` });

  return {
    tool: "custom-agent",
    model: AGENT_MODEL,
    scannedAt: new Date().toISOString(),
    findingsCount: items.length + aiReviewFindings.length,
    groups: allGroups,
    batchErrors,
    unexplainedCount: groups.filter((g) => !byKey.has(g.key)).length,
    totalCostUsd,
  };
}
