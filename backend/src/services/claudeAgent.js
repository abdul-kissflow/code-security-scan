import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { isBenignScanPath } from "./projectProfile.js";

// One way for every AI stage to reach Claude: the Claude Agent SDK, which drives the `claude` CLI
// and therefore rides on whatever that CLI is already authenticated with. No Vertex project, no
// API key, no `gcloud auth application-default login` - the same property the ai-plugin
// code-scan gate has, where every AI surface is a Claude Code subagent rather than a direct API
// call (see reference/CODE-SCAN.md, "Why AI review runs as subagents, not an API call").
//
// The agent explores the extracted codebase with the CLI's own Read/Grep/Glob and returns
// structured JSON via outputFormat, so callers get the same shape the hand-rolled tool loop used
// to submit through a tool schema.

const READ_ONLY_TOOLS = ["Read", "Grep", "Glob"];
// Belt and braces alongside allowedTools: nothing may run commands, write files, or reach the
// network - this is untrusted uploaded code being inspected.
const FORBIDDEN_TOOLS = ["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit", "WebFetch", "WebSearch", "Task"];

export const AGENT_MODEL = process.env.CLAUDE_REVIEW_MODEL || process.env.CLAUDE_EXPLAIN_MODEL || "claude-sonnet-4-5";

function makeAbortError() {
  const err = new Error("Aborted");
  err.name = "AbortError";
  return err;
}

/**
 * The CLI inherits our environment, so the backend's own Vertex settings would send it looking for
 * Google credentials this stage deliberately no longer needs. Strip them and let the CLI use its
 * own logged-in auth.
 */
function cliEnv() {
  const env = { ...process.env };
  delete env.CLAUDE_CODE_USE_VERTEX;
  delete env.ANTHROPIC_VERTEX_PROJECT_ID;
  delete env.CLOUD_ML_REGION;
  return env;
}

/** Every path-ish argument a read-only tool can carry. */
function pathsIn(input) {
  return [input?.file_path, input?.path, input?.notebook_path].filter((p) => typeof p === "string" && p.length > 0);
}

/**
 * The one place the read rules are decided: only the read-only tools, only inside the extracted
 * codebase, and never a known-benign path (.env files, the scaffold's cert/) - the mechanical half
 * of the prompt's out-of-scope rule. Returns a deny reason, or null to allow.
 *
 * Enforced from a PreToolUse hook rather than canUseTool: the CLI auto-approves reads INSIDE its
 * working directory without consulting canUseTool (verified - only the /etc/hosts read reached the
 * callback), so the callback alone would have let every .env read through. The hook runs on every
 * tool call, so it is the only surface that actually holds.
 */
function denyReason(root, scope, toolName, input) {
  if (FORBIDDEN_TOOLS.includes(toolName) || !READ_ONLY_TOOLS.includes(toolName)) {
    return `${toolName} is not available in this review - read-only tools only.`;
  }
  for (const p of pathsIn(input)) {
    const resolved = path.resolve(root, p);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      return `Outside the codebase being reviewed: ${p}`;
    }
    if (isBenignScanPath(path.relative(root, resolved), scope)) {
      return `Out of scope for this review: ${p}`;
    }
  }
  return null;
}

function makePreToolUseHook(extractDir, scope, onDeny) {
  const root = path.resolve(extractDir);
  return async (input) => {
    const reason = denyReason(root, scope, input.tool_name, input.tool_input || {});
    if (!reason) return { continue: true };
    onDeny(reason);
    return {
      continue: true,
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
    };
  };
}

/** Second line of defence for anything that does reach the permission callback. */
function makeCanUseTool(extractDir, scope) {
  const root = path.resolve(extractDir);
  return async (toolName, input) => {
    const reason = denyReason(root, scope, toolName, input);
    return reason ? { behavior: "deny", message: reason } : { behavior: "allow" };
  };
}

function describeToolUse(name, input) {
  if (name === "Read") return `Reading ${input?.file_path ?? "a file"}`;
  if (name === "Grep") return `Searching for "${input?.pattern ?? "?"}"${input?.path ? ` in ${input.path}` : ""}`;
  if (name === "Glob") return `Listing files matching "${input?.pattern ?? "?"}"`;
  return `Using ${name}`;
}

/**
 * Runs one read-only Claude Code session over `extractDir` and returns its structured output.
 *
 * Every event is a real thing the agent just did (file read, search, summary) - nothing simulated -
 * so SSE progress stays honest, same as the tool loop this replaced.
 */
export async function runCodebaseAgent({
  extractDir,
  scope,
  prompt,
  schema,
  onEvent = () => {},
  signal,
  maxTurns,
  maxBudgetUsd,
  model = AGENT_MODEL,
  label = "",
}) {
  const say = (evt) => onEvent(label ? { ...evt, text: `${label} ${evt.text}` } : evt);

  // The SDK takes a controller, the scan routes hand us a signal (one per scan, see
  // abortRegistry.js) - bridge the two so aborting a scan stops its agents too.
  const controller = new AbortController();
  if (signal) {
    if (signal.aborted) throw makeAbortError();
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  let finalMessage = null;
  try {
    for await (const message of query({
      prompt,
      options: {
        cwd: extractDir,
        model,
        // Deliberately NO `allowedTools`: a bare tool name there auto-approves the whole tool
        // before canUseTool runs (the SDK warns CLAUDE_SDK_CAN_USE_TOOL_SHADOWED), which would
        // silently disable the path guard below. Everything falls through to canUseTool instead,
        // which allows only the read-only tools and only inside the codebase.
        disallowedTools: FORBIDDEN_TOOLS,
        canUseTool: makeCanUseTool(extractDir, scope),
        hooks: {
          PreToolUse: [
            { hooks: [makePreToolUseHook(extractDir, scope, (reason) => say({ type: "status", text: `Blocked: ${reason}` }))] },
          ],
        },
        // SDK isolation: never load this machine's own settings/CLAUDE.md into a scan of someone
        // else's uploaded code.
        settingSources: [],
        env: cliEnv(),
        abortController: controller,
        ...(maxTurns ? { maxTurns } : {}),
        ...(maxBudgetUsd ? { maxBudgetUsd } : {}),
        outputFormat: { type: "json_schema", schema },
      },
    })) {
      switch (message.type) {
        case "system":
          if (message.subtype === "init") say({ type: "status", text: `Started (model ${message.model})` });
          break;
        case "assistant":
          for (const block of message.message.content) {
            if (block.type === "tool_use") say({ type: "tool", text: describeToolUse(block.name, block.input) });
          }
          break;
        case "tool_progress":
          if (message.heartbeat) {
            say({ type: "heartbeat", text: `Still running ${message.tool_name} (${message.elapsed_time_seconds}s)` });
          }
          break;
        case "tool_use_summary":
          say({ type: "summary", text: message.summary });
          break;
        case "result":
          finalMessage = message;
          break;
        default:
          break;
      }
    }
  } catch (err) {
    if (controller.signal.aborted) throw makeAbortError();
    throw err;
  }

  if (controller.signal.aborted) throw makeAbortError();
  if (!finalMessage) throw new Error("The Claude Code session produced no result");
  if (finalMessage.subtype !== "success") {
    throw new Error(
      `Claude Code session failed (${finalMessage.subtype}): ${finalMessage.errors?.join("; ") || "no error detail"}`
    );
  }
  if (!finalMessage.structured_output) {
    // Usually the turn cap or the budget cap landing before the model returned its answer.
    throw new Error(
      `The Claude Code session ended without returning its answer (${finalMessage.num_turns ?? "?"} turns, $${(finalMessage.total_cost_usd ?? 0).toFixed(2)}) - it likely hit the turn or budget cap`
    );
  }

  return {
    structured: finalMessage.structured_output,
    costUsd: finalMessage.total_cost_usd ?? null,
    numTurns: finalMessage.num_turns ?? null,
  };
}
