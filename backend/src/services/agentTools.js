import fs from "node:fs";
import path from "node:path";
import { isBenignScanPath } from "./projectProfile.js";

// Shared read-only codebase exploration tools for our own tool-use agents
// (fastExplainer.js, aiCodeReview.js) - not the Claude Agent SDK, just plain
// functions we implement and execute ourselves via the standard tool-use loop
// on the Messages API. The model decides what to read/search/list; we carry
// it out safely, scoped to the extracted codebase root.

const MAX_SEARCH_RESULTS = 40;
const MAX_LIST_RESULTS = 500;
const MAX_FILE_BYTES = 300 * 1024; // skip anything obviously not source (bundles, images mislabeled, etc.)
const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage"]);

function resolveSafe(extractDir, relPath) {
  const resolved = path.resolve(extractDir, relPath || ".");
  if (resolved !== extractDir && !resolved.startsWith(extractDir + path.sep)) {
    throw new Error(`Path escapes the codebase root: ${relPath}`);
  }
  return resolved;
}

// When a scan scope is passed (the AI review), .env files and the scaffold's cert/ are invisible
// to the model - not just discouraged by the prompt. Same list the secrets stage filters on.
function isHidden(extractDir, filePath, scope) {
  return scope ? isBenignScanPath(path.relative(extractDir, filePath), scope) : false;
}

function readFile(extractDir, input, scope) {
  const filePath = resolveSafe(extractDir, input.path);
  if (isHidden(extractDir, filePath, scope)) return `Out of scope for this review: ${input.path}`;
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) return `Not a file: ${input.path}`;
  if (stat.size > MAX_FILE_BYTES) return `File too large to read (${stat.size} bytes): ${input.path}`;

  const lines = fs.readFileSync(filePath, "utf8").split("\n");
  if (input.line && input.line >= 1) {
    const start = Math.max(0, input.line - 1 - 15);
    const end = Math.min(lines.length, input.line + 15);
    return lines.slice(start, end).map((l, i) => `${start + i + 1}: ${l}`).join("\n");
  }
  return lines.slice(0, 200).map((l, i) => `${i + 1}: ${l}`).join("\n");
}

function searchCode(extractDir, input, scope) {
  const root = input.path ? resolveSafe(extractDir, input.path) : extractDir;
  let regex;
  try {
    regex = new RegExp(input.pattern);
  } catch {
    regex = new RegExp(input.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  }

  const results = [];
  function walk(dir) {
    if (results.length >= MAX_SEARCH_RESULTS) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= MAX_SEARCH_RESULTS) return;
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) walk(path.join(dir, entry.name));
        continue;
      }
      const filePath = path.join(dir, entry.name);
      if (isHidden(extractDir, filePath, scope)) continue;
      let content;
      try {
        const stat = fs.statSync(filePath);
        if (stat.size > MAX_FILE_BYTES) continue;
        content = fs.readFileSync(filePath, "utf8");
      } catch {
        continue;
      }
      const lines = content.split("\n");
      for (let i = 0; i < lines.length && results.length < MAX_SEARCH_RESULTS; i++) {
        if (regex.test(lines[i])) {
          results.push(`${path.relative(extractDir, filePath)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
        }
      }
    }
  }
  walk(root);
  return results.length > 0 ? results.join("\n") : "No matches found.";
}

function listFiles(extractDir, input, scope) {
  const root = input.path ? resolveSafe(extractDir, input.path) : extractDir;
  const results = [];
  function walk(dir) {
    if (results.length >= MAX_LIST_RESULTS) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= MAX_LIST_RESULTS) return;
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) walk(path.join(dir, entry.name));
        continue;
      }
      if (isHidden(extractDir, path.join(dir, entry.name), scope)) continue;
      results.push(path.relative(extractDir, path.join(dir, entry.name)));
    }
  }
  walk(root);
  if (results.length === 0) return "No files found.";
  return results.join("\n") + (results.length >= MAX_LIST_RESULTS ? "\n… (truncated, narrow the path)" : "");
}

export const listFilesTool = {
  name: "list_files",
  description: "List files under a directory (recursive), skipping node_modules/.git/dist/build/.next/coverage. Use this first to see the project's shape before deciding what to read.",
  input_schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Optional subdirectory to list, relative to the codebase root. Omit to list everything." },
    },
  },
};

export const readFileTool = {
  name: "read_file",
  description: "Read a file from the codebase. Returns a 30-line window centered on `line` if given, else the first 200 lines.",
  input_schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to the codebase root" },
      line: { type: "integer", description: "Optional line number to center the view on" },
    },
    required: ["path"],
  },
};

export const searchCodeTool = {
  name: "search_code",
  description: "Search the codebase for a regex pattern, like grep -rn. Returns up to 40 matching file:line results.",
  input_schema: {
    type: "object",
    properties: {
      pattern: { type: "string" },
      path: { type: "string", description: "Optional subdirectory to restrict the search to" },
    },
    required: ["pattern"],
  },
};

export function describeExploreTool(name, input) {
  if (name === "list_files") return `Listing files${input.path ? ` in ${input.path}` : ""}`;
  if (name === "read_file") return `Reading ${input.path}${input.line ? `:${input.line}` : ""}`;
  if (name === "search_code") return `Searching for "${input.pattern}"${input.path ? ` in ${input.path}` : ""}`;
  return `Using ${name}`;
}

export function executeExploreTool(extractDir, name, input, scope = null) {
  try {
    if (name === "list_files") return listFiles(extractDir, input, scope);
    if (name === "read_file") return readFile(extractDir, input, scope);
    if (name === "search_code") return searchCode(extractDir, input, scope);
    return `Unknown tool: ${name}`;
  } catch (err) {
    return `Error: ${err.message}`;
  }
}
