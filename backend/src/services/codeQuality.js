import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withNpmLock } from "./npmLock.js";
import { isAbortError } from "./abortRegistry.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = path.join(__dirname, "..", "..", "config");
const BIN_DIR = path.join(__dirname, "..", "..", "node_modules", ".bin");

const ESLINT_BIN = path.join(BIN_DIR, "eslint");
const STYLELINT_BIN = path.join(BIN_DIR, "stylelint");
const TSC_BIN = path.join(BIN_DIR, "tsc");
const ESLINT_CONFIG = path.join(CONFIG_DIR, "eslint.config.mjs");
const STYLELINT_CONFIG = path.join(CONFIG_DIR, "stylelint.config.json");
const TSCONFIG_STATIC = path.join(CONFIG_DIR, "tsconfig.static.json");

function run(bin, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { maxBuffer: 1024 * 1024 * 64, ...opts }, (error, stdout, stderr) => {
      if (error?.name === "AbortError") return reject(error);
      // Every tool here exits non-zero when it finds issues - that's expected,
      // not a failure. Callers inspect stdout/stderr themselves.
      resolve({ error, stdout: stdout || "", stderr: stderr || "" });
    });
  });
}

// ---------------------------------------------------------------------------
// ESLint
// ---------------------------------------------------------------------------

// `files` is the reachable file list for a Kissflow starter app (extractDir-relative, see
// projectProfile.js), or null for "scan the whole tree" - every other upload, and a starter app
// whose import graph couldn't be fully resolved. An empty array means nothing of that type is
// reachable, not "fall back".
async function runEslint(extractDir, files, signal) {
  const unscoped = files === null;
  const targets = unscoped ? ["."] : files.filter((f) => /\.(jsx?|tsx?)$/.test(f));
  if (!unscoped && targets.length === 0) {
    return { tool: "eslint", totalFindings: 0, findings: [], note: "No reachable JS/TS files." };
  }

  const { stdout, stderr, error } = await run(
    ESLINT_BIN,
    ["-c", ESLINT_CONFIG, "--format", "json", "--no-error-on-unmatched-pattern", ...targets],
    { cwd: extractDir, signal }
  );

  let results;
  try {
    results = JSON.parse(stdout || stderr || "[]");
  } catch {
    if (error && !stdout && !stderr) throw new Error(`eslint failed to run: ${error.message}`);
    throw new Error(`eslint produced unparseable output: ${(stderr || stdout).slice(0, 500)}`);
  }

  const findings = [];
  for (const file of results) {
    const relFile = path.relative(extractDir, file.filePath);
    for (const msg of file.messages) {
      if (!msg.ruleId) continue; // parse errors / fatal messages without a rule
      findings.push({
        tool: "eslint",
        rule: msg.ruleId,
        file: relFile,
        line: msg.line ?? null,
        severity: msg.ruleId.startsWith("no-unsanitized/") || msg.ruleId.startsWith("security/") ? "critical" : "high",
        message: msg.message,
      });
    }
  }

  return { tool: "eslint", totalFindings: findings.length, findings };
}

// ---------------------------------------------------------------------------
// TypeScript (tsc --noEmit), always against OUR static config
// ---------------------------------------------------------------------------

const TSC_DIAGNOSTIC_RE = /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.+)$/;

function parseTscOutput(output, extractDir) {
  const findings = [];
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    const match = TSC_DIAGNOSTIC_RE.exec(line);
    if (!match) continue;
    const [, filePath, lineNo, , level, code, message] = match;
    findings.push({
      tool: "typescript",
      rule: code,
      // Normalize regardless of whether tsc printed an absolute or a
      // cwd-relative path - resolve then re-relativize against extractDir.
      file: path.relative(extractDir, path.resolve(extractDir, filePath)),
      line: Number(lineNo),
      severity: level === "error" ? "high" : "medium",
      message,
    });
  }
  return findings;
}

async function installDependencies(extractDir, onEvent, signal) {
  const hasPackageJson = fs.existsSync(path.join(extractDir, "package.json"));
  if (!hasPackageJson) {
    onEvent({ type: "status", text: "No dependencies file found - skipping dependency install" });
    return { installed: false };
  }

  onEvent({ type: "status", text: "Installing dependencies for type checking..." });
  // Serialized against the dependency-audit stage, which may be running
  // concurrently and touching the same extractDir's npm state.
  const { error, stderr } = await withNpmLock(extractDir, () =>
    run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-progress"], {
      cwd: extractDir,
      timeout: 8 * 60 * 1000,
      signal,
    })
  );
  if (error) {
    onEvent({ type: "status", text: "Dependency install failed - type checking results may be incomplete" });
    return { installed: false, error: stderr || error.message };
  }
  onEvent({ type: "status", text: "Dependencies installed" });
  return { installed: true };
}

async function runTypeCheck(extractDir, onEvent, signal) {
  const install = await installDependencies(extractDir, onEvent, signal);

  const staticConfig = JSON.parse(fs.readFileSync(TSCONFIG_STATIC, "utf8"));
  staticConfig.include = [path.join(extractDir, "**/*.ts"), path.join(extractDir, "**/*.tsx")];
  staticConfig.exclude = [
    path.join(extractDir, "**/node_modules/**"),
    path.join(extractDir, "**/dist/**"),
    path.join(extractDir, "**/build/**"),
  ];

  const tempConfigPath = path.join(os.tmpdir(), `tsconfig-scan-${path.basename(extractDir)}.json`);
  fs.writeFileSync(tempConfigPath, JSON.stringify(staticConfig, null, 2));

  try {
    onEvent({ type: "status", text: "Checking types..." });
    const { stdout, stderr } = await run(TSC_BIN, ["--noEmit", "-p", tempConfigPath], {
      cwd: extractDir,
      timeout: 5 * 60 * 1000,
      signal,
    });
    const findings = parseTscOutput(`${stdout}\n${stderr}`, extractDir);
    return {
      tool: "typescript",
      totalFindings: findings.length,
      findings,
      dependenciesInstalled: install.installed,
      installError: install.error || null,
    };
  } finally {
    fs.rmSync(tempConfigPath, { force: true });
  }
}

// ---------------------------------------------------------------------------
// Stylelint
// ---------------------------------------------------------------------------

async function runStylelint(extractDir, files, signal) {
  const unscoped = files === null;
  const targets = unscoped ? ["**/*.css"] : files.filter((f) => f.endsWith(".css"));
  if (!unscoped && targets.length === 0) {
    return { tool: "stylelint", totalFindings: 0, findings: [], note: "No reachable .css files." };
  }

  const { stdout, stderr } = await run(
    STYLELINT_BIN,
    // --allow-empty-input: a codebase with no CSS is a clean result, not a failed tool run.
    ["--config", STYLELINT_CONFIG, "--formatter", "json", "--allow-empty-input", ...targets],
    { cwd: extractDir, signal }
  );

  const raw = stdout || stderr;
  if (!raw.trim()) return { tool: "stylelint", totalFindings: 0, findings: [], note: "No .css files found." };

  let results;
  try {
    results = JSON.parse(raw);
  } catch {
    throw new Error(`stylelint produced unparseable output: ${raw.slice(0, 500)}`);
  }

  const findings = [];
  for (const file of results) {
    if (file.ignored) continue;
    const relFile = path.relative(extractDir, file.source);
    for (const w of file.warnings) {
      findings.push({
        tool: "stylelint",
        rule: w.rule,
        file: relFile,
        line: w.line ?? null,
        severity: "medium",
        message: w.text,
      });
    }
  }

  return { tool: "stylelint", totalFindings: findings.length, findings };
}

// ---------------------------------------------------------------------------
// Suppressed checks
// ---------------------------------------------------------------------------

const SUPPRESSIBLE_FILE_RE = /\.(jsx?|tsx?|mjs|cjs|css|scss)$/;
const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage"]);
const MAX_SUPPRESSION_SCAN_BYTES = 300 * 1024;
const SUPPRESSION_RE = /\b(eslint|stylelint)-disable(?:-next-line|-line)?\b([^\n*]*)/g;

function listSourceFiles(extractDir) {
  const out = [];
  (function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) walk(full);
      } else if (SUPPRESSIBLE_FILE_RE.test(entry.name)) {
        out.push(path.relative(extractDir, full));
      }
    }
  })(extractDir);
  return out;
}

/**
 * Every `eslint-disable`/`stylelint-disable` directive in the scanned files, each reported as its
 * own finding - ported from ai-plugin's kf-code-scanner Step 4. A disabled check is a finding that
 * was hidden rather than fixed, so it counts against the score instead of reading as clean.
 */
function findSuppressedChecks(extractDir, files) {
  const targets = (files === null ? listSourceFiles(extractDir) : files).filter((f) => SUPPRESSIBLE_FILE_RE.test(f));
  const findings = [];
  for (const rel of targets) {
    let text;
    try {
      const full = path.join(extractDir, rel);
      if (fs.statSync(full).size > MAX_SUPPRESSION_SCAN_BYTES) continue; // bundles/minified output
      text = fs.readFileSync(full, "utf8");
    } catch {
      continue;
    }
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      for (const match of lines[i].matchAll(SUPPRESSION_RE)) {
        const rules = match[2].split("--")[0].trim();
        findings.push({
          tool: "suppression",
          rule: "suppressed-check",
          file: rel,
          line: i + 1,
          severity: "high",
          message: `${match[1]}-disable ${rules ? `turns off ${rules}` : "turns off every rule"} here instead of fixing the underlying issue`,
        });
      }
    }
  }
  return { tool: "suppression", totalFindings: findings.length, findings };
}

// ---------------------------------------------------------------------------

/**
 * Runs ESLint, TypeScript type-checking, and Stylelint against the extracted
 * codebase using our own bundled, fixed configs (never the target's own
 * eslint/tsconfig/stylelint config, regardless of whether it has one), plus a
 * scan for suppression directives.
 *
 * For a Kissflow starter app (scope.profile === "kissflow-starter", see
 * projectProfile.js) everything is limited to the files the app actually
 * imports, and tsc is skipped - the scaffold is plain JS/JSX with no types to
 * check, and the check would cost a full npm install for nothing.
 */
export async function runCodeQuality(scan, onEvent = () => {}, signal, scope = { profile: "generic", files: null }) {
  const extractDir = scan.extractDir;
  const files = scope.files ?? null;

  if (scope.profile === "kissflow-starter") {
    onEvent({
      type: "status",
      text:
        files === null
          ? "Kissflow starter app - import graph has unresolvable dynamic imports, scanning the whole tree"
          : `Kissflow starter app - scanning ${files.length} file(s) the app actually imports`,
    });
  }

  onEvent({ type: "status", text: "Checking code standards..." });
  const eslint = await runEslint(extractDir, files, signal).catch((err) => {
    if (isAbortError(err)) throw err; // stop the whole stage, don't run the next tool
    return { tool: "eslint", totalFindings: 0, findings: [], error: err.message };
  });
  onEvent({ type: "summary", text: `Code standards: ${eslint.totalFindings} finding(s)` });

  onEvent({ type: "status", text: "Checking styling rules..." });
  const stylelint = await runStylelint(extractDir, files, signal).catch((err) => {
    if (isAbortError(err)) throw err;
    return { tool: "stylelint", totalFindings: 0, findings: [], error: err.message };
  });
  onEvent({ type: "summary", text: `Styling: ${stylelint.totalFindings} finding(s)` });

  onEvent({ type: "status", text: "Checking for suppressed lint checks..." });
  const suppressions = findSuppressedChecks(extractDir, files);
  onEvent({ type: "summary", text: `Suppressed checks: ${suppressions.totalFindings} finding(s)` });

  let typescriptResult;
  if (scope.profile === "kissflow-starter") {
    typescriptResult = { tool: "typescript", totalFindings: 0, findings: [], skipped: true, note: "Skipped - Kissflow starter apps are plain JS/JSX." };
  } else {
    onEvent({ type: "status", text: "Checking types (this step installs dependencies first, can take a while)..." });
    typescriptResult = await runTypeCheck(extractDir, onEvent, signal).catch((err) => {
      if (isAbortError(err)) throw err;
      return { tool: "typescript", totalFindings: 0, findings: [], error: err.message };
    });
    onEvent({ type: "summary", text: `Type safety: ${typescriptResult.totalFindings} finding(s)` });
  }

  const allFindings = [...eslint.findings, ...typescriptResult.findings, ...stylelint.findings, ...suppressions.findings];

  return {
    tool: "code-quality",
    scannedAt: new Date().toISOString(),
    totalFindings: allFindings.length,
    findings: allFindings,
    eslint,
    typescript: typescriptResult,
    stylelint,
    suppressions,
    scope: { profile: scope.profile, scopedFileCount: files === null ? null : files.length },
  };
}
