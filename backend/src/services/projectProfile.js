import fs from "node:fs";
import path from "node:path";
import { computeReachableFiles } from "./reachability.js";
import { isKnownBenignPath } from "../../config/known-benign-paths.js";

// Decides, once per scan, which of two scan profiles an upload gets:
//
// - "kissflow-starter": a Kissflow custom-UI app built on the starter scaffold (the target of
//   an AI app-builder plugin's code-scan gate). The starter-only filters apply: lint/Sonar are
//   scoped to files the app actually imports (reachability.js), the scaffold's own dependencies
//   don't count against the score (config/baseline-deps.js), and tsc is skipped (plain JS/JSX).
// - "generic": any other codebase (e.g. a TS/TSX monorepo). Whole tree, every dependency
//   counts, TypeScript type-check runs - the scanner's original behavior.
//
// Computed right after upload and cached as storage/<scanId>/scope.json, so every stage route
// (each its own request) reads the same answer instead of re-deriving it.

const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage"]);
const STARTER_MARKER_DEPS = ["@kissflow/app-ui", "@kissflow/lowcode-client-sdk"];
const MAX_ROOT_SEARCH_DEPTH = 3;

/**
 * The shallowest directory holding a package.json - uploads are often zipped with one wrapper
 * folder (my-app/package.json), so the extract root itself isn't always the project root.
 * Returns an extractDir-relative path ("" for the extract root itself).
 */
function findProjectRoot(extractDir) {
  let level = [extractDir];
  for (let depth = 0; depth <= MAX_ROOT_SEARCH_DEPTH && level.length > 0; depth++) {
    const found = level.find((dir) => fs.existsSync(path.join(dir, "package.json")));
    if (found) return path.relative(extractDir, found);
    const next = [];
    for (const dir of level) {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (e.isDirectory() && !IGNORED_DIRS.has(e.name)) next.push(path.join(dir, e.name));
      }
    }
    level = next;
  }
  return "";
}

function isKissflowStarter(projectDir) {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(projectDir, "package.json"), "utf8"));
  } catch {
    return false;
  }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  return STARTER_MARKER_DEPS.some((d) => d in deps) && fs.existsSync(path.join(projectDir, "src", "main.jsx"));
}

function computeScope(extractDir) {
  const projectRoot = findProjectRoot(extractDir);
  const projectDir = path.join(extractDir, projectRoot);

  if (!isKissflowStarter(projectDir)) {
    return { profile: "generic", projectRoot, files: null, computedAt: new Date().toISOString() };
  }

  let reachability;
  try {
    reachability = computeReachableFiles(projectDir);
  } catch (err) {
    // Still a starter app (baseline deps, no tsc) - just not scoped, rather than failing the upload.
    return { profile: "kissflow-starter", projectRoot, files: null, reachabilityError: err.message, computedAt: new Date().toISOString() };
  }
  // Fail open, same as the source project: a non-literal dynamic import means the graph doesn't
  // know everything the app reaches, so narrowing scope around it could hide real code.
  const unscoped = reachability.unresolvedDynamicImports.length > 0;
  return {
    profile: "kissflow-starter",
    projectRoot,
    files: unscoped ? null : reachability.reachable.map((f) => path.join(projectRoot, f)),
    reachableCount: reachability.reachable.length,
    usedFrameworkFileCount: reachability.usedFrameworkFiles.length,
    unresolvedDynamicImports: reachability.unresolvedDynamicImports,
    computedAt: new Date().toISOString(),
  };
}

function scopeCachePath(extractDir) {
  return path.join(path.dirname(extractDir), "scope.json");
}

/** Computes and caches the scan scope. Called once right after the zip is extracted. */
export function initScanScope(extractDir) {
  const scope = computeScope(extractDir);
  fs.writeFileSync(scopeCachePath(extractDir), JSON.stringify(scope, null, 2));
  return scope;
}

/** Cached scan scope, computed on first use for scans uploaded before this existed. */
export function getScanScope(extractDir) {
  try {
    return JSON.parse(fs.readFileSync(scopeCachePath(extractDir), "utf8"));
  } catch {
    return initScanScope(extractDir);
  }
}

/**
 * isKnownBenignPath, for an extractDir-relative path: `cert/` is anchored at the project root
 * (the scaffold's cert folder), not wherever the zip's wrapper folder happens to put it.
 */
export function isBenignScanPath(relPath, scope) {
  if (!relPath) return false;
  const normalized = relPath.replace(/\\/g, "/");
  const root = (scope?.projectRoot || "").replace(/\\/g, "/");
  const fromRoot = root && normalized.startsWith(root + "/") ? normalized.slice(root.length + 1) : normalized;
  return isKnownBenignPath(fromRoot);
}
