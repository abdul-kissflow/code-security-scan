import fs from "node:fs";
import path from "node:path";
import { computeHealthScore } from "./healthScore.js";
import { flattenFindings } from "./findings.js";

// Writes every stage's result to disk alongside the extracted codebase, in the same shape
// an internal AI-plugin repo's scan-engine uses (reference/CODE-SCAN.md, "Output layout"):
//
//   storage/<scanId>/
//     extracted/                     the uploaded codebase
//     scope.json                     scan profile (projectProfile.js)
//     scan/
//       history/<runId>/             one folder per run, never overwritten in place
//         secrets.json  dependencies.json  sonar.json  code-quality.json
//         ai-review.json  explanations.json
//         health-score.json  findings.json  scope.json
//       latest/                      a mirror of the newest run
//       current-run.txt              which run is being written to
//
// Postgres stays the source of truth (scan_stages.result is what the API serves); these files are
// for reading, diffing and feeding other tools without a database client. A failure to write them
// must never fail a scan - callers wrap this and log.
//
// Re-running a stage that already has a file in the current run starts a NEW run folder rather
// than clobbering the old one, and the previous run's files are copied in first so every run
// folder is a complete picture rather than a diff.

const STAGE_FILES = {
  secrets: "secrets.json",
  dependencies: "dependencies.json",
  sonar: "sonar.json",
  codeQuality: "code-quality.json",
  aiCodeReview: "ai-review.json",
  explanations: "explanations.json",
};

/** Derived from whatever the stages have produced so far - rewritten on every stage, never a new run. */
const DERIVED_FILES = new Set(["health-score.json", "findings.json", "scope.json"]);

function newRunId() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function writeJson(dir, file, data) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), JSON.stringify(data, null, 2));
}

function layoutFor(extractDir) {
  const scanRoot = path.dirname(extractDir);
  const scanDir = path.join(scanRoot, "scan");
  return {
    scanRoot,
    scanDir,
    historyDir: path.join(scanDir, "history"),
    latestDir: path.join(scanDir, "latest"),
    pointerFile: path.join(scanDir, "current-run.txt"),
  };
}

function currentRunId({ pointerFile }) {
  try {
    const id = fs.readFileSync(pointerFile, "utf8").trim();
    return id || null;
  } catch {
    return null;
  }
}

function setCurrentRunId({ scanDir, pointerFile }, runId) {
  fs.mkdirSync(scanDir, { recursive: true });
  fs.writeFileSync(pointerFile, runId);
}

/** Mirrors the run folder into latest/, so latest/ is always one whole run and never a mix. */
function mirrorToLatest(runDir, latestDir) {
  fs.rmSync(latestDir, { recursive: true, force: true });
  fs.cpSync(runDir, latestDir, { recursive: true });
}

/**
 * Archives one stage's result (or, with stageKey null, just refreshes the derived files after a
 * failed/cancelled stage so health-score.json reflects the incomplete run).
 */
export function archiveStageResult({ scan, stageKey = null, result = null }) {
  const layout = layoutFor(scan.extractDir);
  const stageFile = stageKey ? STAGE_FILES[stageKey] : null;

  let runId = currentRunId(layout);
  if (!runId) {
    runId = newRunId();
    setCurrentRunId(layout, runId);
  } else if (stageFile && fs.existsSync(path.join(layout.historyDir, runId, stageFile))) {
    // This stage already has a result in the current run - that makes this a re-run, which gets
    // its own folder. Carry the previous run's files over so the new folder is complete.
    const previousDir = path.join(layout.historyDir, runId);
    runId = newRunId();
    const runDir = path.join(layout.historyDir, runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.cpSync(previousDir, runDir, { recursive: true });
    setCurrentRunId(layout, runId);
  }

  const runDir = path.join(layout.historyDir, runId);
  if (stageFile) writeJson(runDir, stageFile, result);

  writeJson(runDir, "health-score.json", computeHealthScore(scan));
  writeJson(runDir, "findings.json", { scanId: scan.id, findings: flattenFindings(scan) });
  const scopeFile = path.join(layout.scanRoot, "scope.json");
  if (fs.existsSync(scopeFile)) fs.copyFileSync(scopeFile, path.join(runDir, "scope.json"));

  mirrorToLatest(runDir, layout.latestDir);
  return { runId, runDir, latestDir: layout.latestDir };
}

export { STAGE_FILES, DERIVED_FILES };
