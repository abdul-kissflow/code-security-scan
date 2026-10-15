import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withNpmLock } from "./npmLock.js";
import { BASELINE_DEP_NAMES } from "../../config/baseline-deps.js";

const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage"]);

function findPackageJsonDirs(rootDir) {
  const found = [];

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    if (entries.some((e) => e.isFile() && e.name === "package.json")) {
      found.push(dir);
    }

    for (const entry of entries) {
      if (entry.isDirectory() && !IGNORED_DIRS.has(entry.name)) {
        walk(path.join(dir, entry.name));
      }
    }
  }

  walk(rootDir);
  return found;
}

// pnpm/yarn-only protocols npm can't resolve. These point at local monorepo packages that
// aren't in the upload and aren't on the registry, so there's nothing to audit for them anyway.
const NON_NPM_PROTOCOLS = ["workspace:", "link:", "portal:"];
const DEP_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

/** Returns package.json with non-npm-protocol deps removed, plus the names removed. */
function stripNonNpmDeps(pkg) {
  const skipped = [];
  const sanitized = { ...pkg };
  for (const field of DEP_FIELDS) {
    if (!pkg[field]) continue;
    sanitized[field] = {};
    for (const [name, spec] of Object.entries(pkg[field])) {
      if (typeof spec === "string" && NON_NPM_PROTOCOLS.some((p) => spec.startsWith(p))) skipped.push(name);
      else sanitized[field][name] = spec;
    }
  }
  // Workspace roots fail the same way once their members' workspace: deps are in play.
  delete sanitized.workspaces;
  return { sanitized, skipped: [...new Set(skipped)] };
}

function runNpmAuditIn(dir, signal) {
  return withNpmLock(dir, () => runNpmAuditWithWorkspaceFallback(dir, signal));
}

/**
 * Without a lockfile, a package.json using workspace:/link:/portal: deps makes
 * `npm install --package-lock-only` fail outright. In that case audit a copy of
 * package.json (in a temp dir, so the extracted codebase other stages read is
 * untouched) with those deps removed, and report which ones were skipped.
 */
async function runNpmAuditWithWorkspaceFallback(dir, signal) {
  if (fs.existsSync(path.join(dir, "package-lock.json"))) return runNpmAuditInLocked(dir, signal);

  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  } catch {
    return runNpmAuditInLocked(dir, signal);
  }
  const { sanitized, skipped } = stripNonNpmDeps(pkg);
  if (skipped.length === 0 && !pkg.workspaces) return runNpmAuditInLocked(dir, signal);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "npm-audit-"));
  try {
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify(sanitized, null, 2));
    // Keep any registry config (scoped registries, auth) the project relies on.
    const npmrc = path.join(dir, ".npmrc");
    if (fs.existsSync(npmrc)) fs.copyFileSync(npmrc, path.join(tmpDir, ".npmrc"));
    const result = await runNpmAuditInLocked(tmpDir, signal);
    return { ...result, dir, skippedWorkspaceDeps: skipped };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function runNpmAuditInLocked(dir, signal) {
  return new Promise((resolve, reject) => {
    const hasLockfile = fs.existsSync(path.join(dir, "package-lock.json"));

    const finish = () => {
      execFile(
        "npm",
        ["audit", "--json"],
        { cwd: dir, maxBuffer: 1024 * 1024 * 64, timeout: 3 * 60 * 1000, signal },
        (error, stdout) => {
          if (error?.name === "AbortError") return reject(error);
          // npm audit exits non-zero when vulnerabilities are found; the
          // JSON body on stdout is still valid in that case.
          try {
            const parsed = JSON.parse(stdout || "{}");
            resolve({ dir, ok: true, report: parsed });
          } catch {
            resolve({
              dir,
              ok: false,
              error: error ? error.message : "npm audit produced no parseable output",
            });
          }
        }
      );
    };

    if (hasLockfile) {
      finish();
    } else {
      // npm audit needs a lockfile; generate one without installing deps.
      execFile(
        "npm",
        ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"],
        { cwd: dir, maxBuffer: 1024 * 1024 * 64, timeout: 5 * 60 * 1000, signal },
        (installError) => {
          if (installError?.name === "AbortError") return reject(installError);
          if (installError) {
            resolve({ dir, ok: false, error: `Could not generate package-lock.json: ${installError.message}` });
            return;
          }
          finish();
        }
      );
    }
  });
}

function normalizeAuditReport(dir, rawResult, rootDir, excludedPackages) {
  const relDir = path.relative(rootDir, dir) || ".";

  if (!rawResult.ok) {
    return {
      dir: relDir,
      ok: false,
      error: rawResult.error,
      vulnerabilities: [],
      summary: null,
      skippedWorkspaceDeps: rawResult.skippedWorkspaceDeps || [],
    };
  }

  const report = rawResult.report;
  const vulnObj = report.vulnerabilities || {};
  const allVulnerabilities = Object.entries(vulnObj).map(([pkgName, v]) => ({
    package: pkgName,
    severity: v.severity,
    isDirect: v.isDirect ?? null,
    fixAvailable: v.fixAvailable
      ? typeof v.fixAvailable === "object"
        ? `${v.fixAvailable.name}@${v.fixAvailable.version}`
        : true
      : false,
    via: (v.via || [])
      .map((entry) =>
        typeof entry === "string"
          ? entry
          : { title: entry.title, url: entry.url, severity: entry.severity, range: entry.range }
      )
      .filter((e) => typeof e !== "string"),
    range: v.range,
  }));

  // Kissflow starter apps only (see projectProfile.js): the scaffold's own deps aren't something
  // the app author chose or can fix, so they're dropped from the OUTPUT - npm audit still audits
  // the full tree, and the exclusion is recorded. For every other upload the set is empty.
  const vulnerabilities = allVulnerabilities.filter((v) => !excludedPackages.has(v.package));
  const excludedBaseline = allVulnerabilities.filter((v) => excludedPackages.has(v.package));

  const severityOrder = { critical: 0, high: 1, moderate: 2, low: 3, info: 4 };
  vulnerabilities.sort((a, b) => (severityOrder[a.severity] ?? 9) - (severityOrder[b.severity] ?? 9));

  // Counted from the list actually reported, not npm's metadata.vulnerabilities - that count
  // includes anything excluded above and would disagree with the rows shown.
  const summary = { critical: 0, high: 0, moderate: 0, low: 0, info: 0, total: vulnerabilities.length };
  for (const v of vulnerabilities) if (summary[v.severity] !== undefined) summary[v.severity]++;

  return {
    dir: relDir,
    ok: true,
    summary,
    totalDependencies: report.metadata?.dependencies?.total ?? null,
    vulnerabilities,
    excludedBaselineCount: excludedBaseline.length,
    excludedBaselinePackages: [...new Set(excludedBaseline.map((v) => v.package))],
    skippedWorkspaceDeps: rawResult.skippedWorkspaceDeps || [],
  };
}

/**
 * Locates every package.json under rootDir (skipping node_modules etc.),
 * runs `npm audit` for each, and returns a normalized, readable report.
 */
export async function runDependencyAudit(rootDir, { signal, scope } = {}) {
  const excludedPackages = scope?.profile === "kissflow-starter" ? BASELINE_DEP_NAMES : new Set();
  const packageDirs = findPackageJsonDirs(rootDir);

  if (packageDirs.length === 0) {
    return {
      tool: "npm audit",
      scannedAt: new Date().toISOString(),
      projects: [],
      note: "No package.json found in the uploaded codebase.",
    };
  }

  const results = [];
  for (const dir of packageDirs) {
    const raw = await runNpmAuditIn(dir, signal);
    results.push(normalizeAuditReport(dir, raw, rootDir, excludedPackages));
  }

  const aggregateSummary = results.reduce(
    (acc, r) => {
      if (!r.summary) return acc;
      for (const key of ["critical", "high", "moderate", "low", "info", "total"]) {
        acc[key] = (acc[key] || 0) + (r.summary[key] || 0);
      }
      return acc;
    },
    {}
  );

  return {
    tool: "npm audit",
    scannedAt: new Date().toISOString(),
    aggregateSummary,
    projects: results,
  };
}
