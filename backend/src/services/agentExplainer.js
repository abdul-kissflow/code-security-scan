import { query } from "@anthropic-ai/claude-agent-sdk";
import { flattenFindings } from "./findings.js";

const MODEL = process.env.CLAUDE_EXPLAIN_MODEL || "claude-opus-5";
const MAX_TURNS = Number(process.env.CLAUDE_EXPLAIN_MAX_TURNS || 100);
const MAX_BUDGET_USD = Number(process.env.CLAUDE_EXPLAIN_MAX_BUDGET_USD || 3);

const RESULT_SCHEMA = {
  type: "object",
  properties: {
    groups: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          severity: { type: "string", enum: ["critical", "high", "medium", "low", "info"] },
          sourceTools: { type: "array", items: { type: "string" } },
          issue: { type: "string" },
          why: { type: "string" },
          fix: { type: "string" },
          occurrences: {
            type: "array",
            items: {
              type: "object",
              properties: {
                file: { type: "string" },
                line: { type: ["integer", "null"] },
              },
              required: ["file"],
            },
          },
        },
        required: ["title", "severity", "issue", "why", "fix", "occurrences"],
      },
    },
  },
  required: ["groups"],
};

function buildPrompt(items) {
  return `You are analyzing a static-analysis report for a frontend codebase, already extracted to your current working directory. You have read-only access (Read, Grep, Glob) to explore the actual source files.

Below is the full list of findings from three tools (betterleaks for hardcoded secrets, npm audit for vulnerable dependencies, SonarQube for code quality/security issues), as compact JSON:

${JSON.stringify(items)}

Task:
1. Group findings that represent the same underlying problem (e.g. every occurrence of the same rule, or the same vulnerable package) into one group. Do not create a separate group per occurrence.
2. For each group, read only 1-3 representative files from the ones listed as occurrences — enough to ground your explanation in the real code, not every single occurrence. Do not read files unrelated to the findings.
3. For each group, write:
   - "title": a short, specific name for the problem
   - "severity": the group's overall severity (critical/high/medium/low/info)
   - "sourceTools": which tool(s) reported it
   - "issue": what the problem is, in plain language
   - "why": why it matters (the real risk or consequence), grounded in what you saw in the actual code where useful
   - "fix": a concrete, actionable fix — include a short code snippet if it clarifies the change
   - "occurrences": every file (and line, if known) where this group's problem appears

Cover every finding in the input - each one must belong to exactly one group. Do not skip low-severity findings. Do not fabricate file contents you didn't read.`;
}

function describeToolUse(name, input) {
  switch (name) {
    case "Read":
      return `Reading ${input?.file_path ?? "a file"}`;
    case "Grep":
      return `Searching for "${input?.pattern ?? "?"}"${input?.path ? ` in ${input.path}` : ""}`;
    case "Glob":
      return `Listing files matching "${input?.pattern ?? "?"}"`;
    default:
      return `Using ${name}`;
  }
}

/**
 * Runs the Claude Agent SDK (read-only: Read/Grep/Glob only, no Bash/Write/Edit)
 * against the extracted codebase to explain and group every finding from the
 * three scan stages, producing a structured, groupable report for the UI.
 *
 * onEvent(evt), if given, is called with real events as they stream from the
 * SDK - {type, text} - so a caller can surface accurate live progress instead
 * of a static "please wait" message. Nothing here is simulated: every event
 * corresponds to something the running agent actually just did.
 */
export async function explainIssues(scan, onEvent = () => {}) {
  const items = flattenFindings(scan);
  if (items.length === 0) {
    return { tool: "claude-agent-sdk", model: MODEL, groups: [], note: "No findings to explain." };
  }

  const prompt = buildPrompt(items);
  let finalMessage = null;

  for await (const message of query({
    prompt,
    options: {
      cwd: scan.extractDir,
      model: MODEL,
      tools: ["Read", "Grep", "Glob"],
      permissionMode: "default",
      maxTurns: MAX_TURNS,
      maxBudgetUsd: MAX_BUDGET_USD,
      outputFormat: { type: "json_schema", schema: RESULT_SCHEMA },
    },
  })) {
    switch (message.type) {
      case "system":
        if (message.subtype === "init") {
          onEvent({ type: "status", text: `Started (model ${message.model}, tools: ${message.tools.join(", ")})` });
        }
        break;
      case "assistant":
        for (const block of message.message.content) {
          if (block.type === "tool_use") {
            onEvent({ type: "tool", text: describeToolUse(block.name, block.input) });
          } else if (block.type === "text" && block.text?.trim()) {
            onEvent({ type: "text", text: block.text.trim() });
          }
        }
        break;
      case "tool_progress":
        if (message.heartbeat) {
          onEvent({ type: "heartbeat", text: `Still running ${message.tool_name} (${message.elapsed_time_seconds}s)` });
        }
        break;
      case "tool_use_summary":
        onEvent({ type: "summary", text: message.summary });
        break;
      case "result":
        finalMessage = message;
        break;
      default:
        break;
    }
  }

  if (!finalMessage) {
    throw new Error("Claude Agent SDK produced no result message");
  }
  if (finalMessage.subtype !== "success") {
    throw new Error(`Claude Agent SDK run failed (${finalMessage.subtype}): ${finalMessage.errors?.join("; ") || "no error detail"}`);
  }

  const structured = finalMessage.structured_output;
  if (!structured || !Array.isArray(structured.groups)) {
    throw new Error("Claude Agent SDK did not return the expected structured output");
  }

  return {
    tool: "claude-agent-sdk",
    model: MODEL,
    scannedAt: new Date().toISOString(),
    findingsCount: items.length,
    groups: structured.groups,
    totalCostUsd: finalMessage.total_cost_usd,
    numTurns: finalMessage.num_turns,
  };
}
