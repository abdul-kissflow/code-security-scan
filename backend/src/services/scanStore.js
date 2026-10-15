import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "../db.js";
import { computeHealthScore } from "./healthScore.js";
import { archiveStageResult } from "./reportArchive.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const STORAGE_ROOT = path.join(__dirname, "..", "..", "storage");

// Matches the keys every service already reads/writes on scan.results - kept
// as-is so healthScore.js/findings.js/fastExplainer.js/codeQuality.js don't
// need to change at all now that this is backed by Postgres instead of an
// in-memory Map. Postgres is the source of truth; this object shape is just
// the stable interface the rest of the app was already written against.
// aiCodeReview runs before explanations (Final Report) and after everything
// else - see fastExplainer.js, which reads its findings directly rather than
// re-explaining them.
export const STAGE_KEYS = ["secrets", "dependencies", "sonar", "codeQuality", "aiCodeReview", "explanations"];

/** Turns a `scans` row + its `scan_stages` rows into the shape every service expects. */
function assembleScan(scanRow, stageRows) {
  const results = {};
  const stageStatus = {};
  for (const key of STAGE_KEYS) {
    const row = stageRows.find((r) => r.stage_key === key);
    results[key] = row?.status === "done" ? row.result : null;
    stageStatus[key] = row?.status || "idle";
  }
  return {
    id: scanRow.id,
    userId: scanRow.user_id,
    originalName: scanRow.original_name,
    fileCount: scanRow.file_count,
    extractDir: scanRow.extract_dir,
    overallStatus: scanRow.overall_status,
    healthScore: scanRow.health_score,
    createdAt: scanRow.created_at,
    updatedAt: scanRow.updated_at,
    results,
    stageStatus,
  };
}

async function fetchScanRow(id) {
  return (await pool.query("select * from scans where id = $1", [id])).rows[0];
}

async function fetchStageRows(id) {
  return (await pool.query("select * from scan_stages where scan_id = $1", [id])).rows;
}

/** The assembled scan, without the owner check requireScan does - for internal callers only. */
async function fetchAssembledScan(id) {
  const scanRow = await fetchScanRow(id);
  if (!scanRow) return null;
  return assembleScan(scanRow, await fetchStageRows(id));
}

/**
 * Mirrors the run to disk (storage/<scanId>/scan/, see reportArchive.js). Postgres remains the
 * source of truth: a failure to write the files is logged and swallowed, never propagated into
 * the stage's own result.
 */
async function archiveToStorage(scanId, stageKey, result) {
  try {
    const scan = await fetchAssembledScan(scanId);
    if (scan) archiveStageResult({ scan, stageKey, result });
  } catch (err) {
    console.error(`Could not archive scan ${scanId} (${stageKey || "derived"}) to storage:`, err.message);
  }
}

/** Creates a scan (and its 5 idle stage rows) for a user. Zip extraction happens after, in the route. */
export async function createScan(userId, { originalName }) {
  const id = randomUUID();
  const extractDir = path.join(STORAGE_ROOT, id, "extracted");

  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(
      `insert into scans (id, user_id, original_name, file_count, extract_dir, overall_status)
       values ($1, $2, $3, 0, $4, 'running')`,
      [id, userId, originalName, extractDir]
    );
    for (const key of STAGE_KEYS) {
      await client.query("insert into scan_stages (scan_id, stage_key, status) values ($1, $2, 'idle')", [id, key]);
    }
    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }

  return requireScan(id, userId);
}

/** Records the real file count once the zip is extracted (createScan inserts with 0). */
export async function setUploadComplete(scanId, fileCount) {
  await pool.query("update scans set file_count = $1, updated_at = now() where id = $2", [fileCount, scanId]);
}

/**
 * Fetches a scan, scoped to its owner. Not found and not-owned are
 * indistinguishable (both 404) - a scan belonging to another user should
 * never be confirmed to exist.
 */
export async function requireScan(id, userId) {
  const scanRow = await fetchScanRow(id);
  if (!scanRow || scanRow.user_id !== userId) {
    const err = new Error(`Scan ${id} not found`);
    err.status = 404;
    throw err;
  }
  const stageRows = await fetchStageRows(id);
  return assembleScan(scanRow, stageRows);
}

/** Lightweight list for the left nav - one row per scan, status per stage for the status dots. */
export async function listScansForUser(userId) {
  const { rows } = await pool.query(
    "select * from scans where user_id = $1 order by created_at desc",
    [userId]
  );
  if (rows.length === 0) return [];

  const { rows: stageRows } = await pool.query(
    "select * from scan_stages where scan_id = any($1)",
    [rows.map((r) => r.id)]
  );
  const stagesByScan = new Map();
  for (const r of stageRows) {
    if (!stagesByScan.has(r.scan_id)) stagesByScan.set(r.scan_id, []);
    stagesByScan.get(r.scan_id).push(r);
  }

  return rows.map((r) => assembleScan(r, stagesByScan.get(r.id) || []));
}

function computeOverallStatus(stageRows) {
  if (stageRows.some((s) => s.status === "running")) return "running";
  if (stageRows.some((s) => s.status === "error")) return "error";
  if (stageRows.some((s) => s.status === "idle")) return "running"; // still has work queued
  return "done";
}

/** Recomputes overall_status + cached health_score from the current stage rows. */
async function refreshScanSummary(scanId) {
  const scanRow = await fetchScanRow(scanId);
  if (!scanRow || scanRow.overall_status === "cancelled") return; // cancellation is terminal, never overwritten
  const stageRows = await fetchStageRows(scanId);
  const overallStatus = computeOverallStatus(stageRows);
  const health = computeHealthScore(assembleScan(scanRow, stageRows));
  await pool.query(
    "update scans set overall_status = $1, health_score = $2, updated_at = now() where id = $3",
    [overallStatus, health.overall, scanId]
  );
}

export async function startStage(scanId, stageKey) {
  await pool.query(
    "update scan_stages set status = 'running', started_at = now() where scan_id = $1 and stage_key = $2",
    [scanId, stageKey]
  );
  await pool.query(
    "update scans set overall_status = 'running', updated_at = now() where id = $1 and overall_status != 'cancelled'",
    [scanId]
  );
}

export async function completeStage(scanId, stageKey, result) {
  await pool.query(
    "update scan_stages set status = 'done', result = $3, completed_at = now() where scan_id = $1 and stage_key = $2",
    [scanId, stageKey, JSON.stringify(result)]
  );
  await refreshScanSummary(scanId);
  await archiveToStorage(scanId, stageKey, result);
}

export async function failStage(scanId, stageKey, errorMessage) {
  await pool.query(
    "update scan_stages set status = 'error', error_message = $3, completed_at = now() where scan_id = $1 and stage_key = $2",
    [scanId, stageKey, errorMessage]
  );
  await refreshScanSummary(scanId);
  // No stage file to write for a failure, but the derived files must still be refreshed so
  // health-score.json shows the run as incomplete rather than clean.
  await archiveToStorage(scanId, null, null);
}

/**
 * Stops an entire run, not one stage: every stage still 'running' or 'idle'
 * (never got to start) flips to 'cancelled' together, in one update. Stages
 * already 'done' keep their real results - cancelling doesn't discard
 * completed work, it only stops what hadn't finished yet.
 *
 * health_score is cleared to null, not recomputed from the partial data - a
 * precise-looking number built from an incomplete run is misleading, not
 * just unavailable, so callers (the nav list, the scan page) should treat a
 * cancelled scan as having no score at all rather than a real one.
 */
export async function cancelScan(scanId) {
  await pool.query(
    "update scan_stages set status = 'cancelled', completed_at = now() where scan_id = $1 and status in ('running', 'idle')",
    [scanId]
  );
  await pool.query(
    "update scans set overall_status = 'cancelled', health_score = null, updated_at = now() where id = $1",
    [scanId]
  );
}
