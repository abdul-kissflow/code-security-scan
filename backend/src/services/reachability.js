import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

// Ported from an internal AI-plugin repo's scan-engine/services/reachability.mjs. Used ONLY for uploads
// detected as a Kissflow custom-UI starter app (see projectProfile.js) - its entry points are that
// scaffold's conventions, so for any other codebase the result would be meaningless.
//
// Computes which files the generated app ACTUALLY uses, so every scan stage checks what ships,
// not the whole starter kit inventory. Computed once per scan (projectProfile.js caches it) before
// the code-quality and Sonar stages use it as their scope.
//
// Framework dirs (src/components/kit/**, src/components/ui/**, src/components/legacy/**) are
// pre-built, not authored by kf-ui-builder - scanning ALL of them (a) drags the health score down
// with findings in code the app-building agents never touched, and (b) can misclassify an unused
// legacy file as "orphaned" (kf-review-maintainability's dead_architecture check) when
// check-retired.mjs's own rule is that legacy/ stays until nothing imports it - it isn't dead by
// being unscanned, it's dead by being unreachable, which is exactly what this computes.
//
// Parser: reuses `typescript` (already a scan-engine dep) as a JS/JSX-capable AST parser - not for
// type-checking (codeQuality.js skips tsc for starter apps - there are no types to check), just for real import/export edges
// instead of a regex line-scan.

const CODE_EXT = [".jsx", ".js", ".tsx", ".ts"];
const FRAMEWORK_DIRS = ["src/components/kit", "src/components/ui", "src/components/legacy"];

function scriptKindFor(file) {
  if (file.endsWith(".tsx") || file.endsWith(".jsx")) return ts.ScriptKind.TSX;
  return ts.ScriptKind.TS; // ts.ScriptKind.TS parses plain .js/.ts fine; JSX-in-.js is rare here
}

function resolveModule(specifier, fromFile, appDir) {
  if (specifier.startsWith(".")) {
    return path.resolve(path.dirname(fromFile), specifier);
  }
  if (specifier.startsWith("@/")) {
    return path.join(appDir, "src", specifier.slice(2));
  }
  return null; // bare package specifier (react, @kissflow/app-ui, lucide-react, ...) - node_modules, out of scope
}

function existingFile(candidate) {
  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  for (const ext of CODE_EXT) {
    if (fs.existsSync(candidate + ext)) return candidate + ext;
  }
  for (const ext of CODE_EXT) {
    const idx = path.join(candidate, `index${ext}`);
    if (fs.existsSync(idx)) return idx;
  }
  if (fs.existsSync(candidate + ".css")) return candidate + ".css";
  return null;
}

/** Every import/export-from/dynamic-import specifier in a JS/JSX/TS/TSX file, via a real AST walk. */
function extractSpecifiers(file) {
  const text = fs.readFileSync(file, "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKindFor(file));
  const specifiers = [];
  let unresolvableDynamicImport = false;

  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (ts.isStringLiteral(node.moduleSpecifier)) specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0];
      if (arg && ts.isStringLiteral(arg)) specifiers.push(arg.text);
      else unresolvableDynamicImport = true; // a template/variable specifier - can't resolve statically
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return { specifiers, unresolvableDynamicImport };
}

/** Plain-text `@import "./x.css"` / `@import url(./x.css)` inside a CSS file. */
function extractCssImports(file) {
  const text = fs.readFileSync(file, "utf8");
  const specifiers = [];
  const re = /@import\s+(?:url\()?["']([^"']+)["']\)?/g;
  let m;
  while ((m = re.exec(text))) specifiers.push(m[1]);
  return specifiers;
}

function listFilesRecursive(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(p));
    else out.push(p);
  }
  return out;
}

/**
 * Walks the real import graph from the app's entry points and returns everything actually used.
 * Roots: src/main.jsx, every file under src/pages/** (file-based routing - vite-plugin-pages
 * discovers these by convention, not by main.jsx importing them), src/components/app-shell.jsx.
 */
export function computeReachableFiles(appDir) {
  const srcDir = path.join(appDir, "src");
  const roots = [
    path.join(srcDir, "main.jsx"),
    path.join(srcDir, "components", "app-shell.jsx"),
    ...listFilesRecursive(path.join(srcDir, "pages")),
  ].filter((f) => fs.existsSync(f));

  const visited = new Set();
  const unresolvedDynamicImports = [];
  const queue = [...roots];

  while (queue.length) {
    const file = queue.shift();
    const abs = path.resolve(file);
    if (visited.has(abs) || !fs.existsSync(abs)) continue;
    visited.add(abs);

    const isCss = abs.endsWith(".css");
    const specifiers = isCss
      ? extractCssImports(abs)
      : (() => {
          const { specifiers: s, unresolvableDynamicImport } = extractSpecifiers(abs);
          if (unresolvableDynamicImport) unresolvedDynamicImports.push(path.relative(appDir, abs));
          return s;
        })();

    for (const spec of specifiers) {
      const resolved = resolveModule(spec, abs, appDir);
      if (!resolved) continue; // bare package - skip
      const real = existingFile(resolved);
      if (real) queue.push(real);
    }
  }

  const rel = (p) => path.relative(appDir, p);
  const reachable = [...visited].map(rel);
  const usedFrameworkFiles = reachable.filter((f) => FRAMEWORK_DIRS.some((d) => f.startsWith(d + path.sep) || f === d));

  return {
    appDir,
    computedAt: new Date().toISOString(),
    roots: roots.map(rel),
    reachable,
    usedFrameworkFiles,
    // Fail OPEN: an unresolvable dynamic import means "we don't know what this reaches" - the
    // caller should NOT silently narrow scope around it. Surfaced so kf-code-scanner can say so.
    unresolvedDynamicImports,
  };
}
