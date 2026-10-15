import { Router } from "express";
import fs from "node:fs";
import multer from "multer";
import path from "node:path";
import {
  createScan,
  requireScan,
  setUploadComplete,
  listScansForUser,
  startStage,
  completeStage,
  failStage,
  cancelScan,
  STORAGE_ROOT,
} from "../services/scanStore.js";
import { extractZip } from "../services/zipExtract.js";
import { runBetterleaks } from "../services/betterleaks.js";
import { runDependencyAudit } from "../services/npmAudit.js";
import { getSonarReport } from "../services/sonar.js";
import { runSonarAnalysis } from "../services/sonarScanner.js";
import { explainIssues } from "../services/fastExplainer.js";
import { runCodeQuality } from "../services/codeQuality.js";
import { runAiCodeReview } from "../services/aiCodeReview.js";
import { computeHealthScore } from "../services/healthScore.js";
import { initScanScope, getScanScope } from "../services/projectProfile.js";
import { getOrCreateController, abortScan, clearController, isAbortError } from "../services/abortRegistry.js";

const router = Router();

const upload = multer({
  storage: multer.diskStorage({
    destination: async (req, file, cb) => {
      try {
        const scan = await createScan(req.user.id, { originalName: file.originalname });
        req.scan = scan;
        fs.mkdirSync(path.join(STORAGE_ROOT, scan.id), { recursive: true });
        cb(null, path.join(STORAGE_ROOT, scan.id));
      } catch (err) {
        cb(err);
      }
    },
    filename: (req, file, cb) => cb(null, "upload.zip"),
  }),
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const isZip =
      file.mimetype === "application/zip" ||
      file.mimetype === "application/x-zip-compressed" ||
      file.originalname.toLowerCase().endsWith(".zip");
    cb(isZip ? null : new Error("Only .zip files are accepted"), isZip);
  },
});

// List of the current user's scans, for the left nav - one row per scan
// with per-stage status, no full results (those are fetched on demand via
// GET /:id once a scan is actually selected).
router.get("/", async (req, res, next) => {
  try {
    res.json(await listScansForUser(req.user.id));
  } catch (err) {
    next(err);
  }
});

router.post("/", upload.single("codebase"), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded (expected field name 'codebase')" });
    }

    const scan = req.scan;
    const { fileCount } = extractZip(req.file.path, scan.extractDir);
    fs.unlinkSync(req.file.path); // don't keep the raw zip around once extracted
    // Kissflow starter app vs. anything else - decides which stages scope/filter what (see
    // services/projectProfile.js). Computed once here and cached for every stage route below.
    const scope = initScanScope(scan.extractDir);
    await setUploadComplete(scan.id, fileCount);

    res.status(201).json({ id: scan.id, status: "extracted", originalName: scan.originalName, fileCount, profile: scope.profile });
  } catch (err) {
    next(err);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    res.json(await requireScan(req.params.id, req.user.id));
  } catch (err) {
    next(err);
  }
});

// Aggregates whatever stages have finished so far into a single 0-100
// codebase health score (see services/healthScore.js) - cheap to compute, so
// this just runs fresh on every request rather than being cached on the scan
// (scans.health_score is a separate write-through cache used only by the
// nav list, not read here).
router.get("/:id/health", async (req, res, next) => {
  try {
    const scan = await requireScan(req.params.id, req.user.id);
    res.json(computeHealthScore(scan));
  } catch (err) {
    next(err);
  }
});

// Stops the entire run, not one stage: every stage still running or not yet
// started flips to 'cancelled' together (see scanStore.cancelScan). Stages
// that already finished keep their real results.
router.post("/:id/abort", async (req, res, next) => {
  try {
    const scan = await requireScan(req.params.id, req.user.id);
    if (scan.overallStatus !== "running") {
      return res.status(409).json({ error: `Scan is already ${scan.overallStatus} - nothing to abort` });
    }
    abortScan(scan.id);
    await cancelScan(scan.id);
    clearController(scan.id);
    res.json(await requireScan(scan.id, req.user.id));
  } catch (err) {
    next(err);
  }
});

router.post("/:id/secrets", async (req, res, next) => {
  const scan = await requireScan(req.params.id, req.user.id).catch(next);
  if (!scan) return;
  if (scan.overallStatus === "cancelled") return res.status(409).json({ error: "This run was cancelled" });

  const controller = getOrCreateController(scan.id);
  try {
    await startStage(scan.id, "secrets");
    const report = await runBetterleaks(scan.extractDir, { signal: controller.signal, scope: getScanScope(scan.extractDir) });
    await completeStage(scan.id, "secrets", report);
    res.json(report);
  } catch (err) {
    if (isAbortError(err)) return res.status(200).json({ cancelled: true }); // scanStore.cancelScan already recorded this
    await failStage(scan.id, "secrets", err.message).catch(() => {});
    next(err);
  }
});

router.post("/:id/dependencies", async (req, res, next) => {
  const scan = await requireScan(req.params.id, req.user.id).catch(next);
  if (!scan) return;
  if (scan.overallStatus === "cancelled") return res.status(409).json({ error: "This run was cancelled" });

  const controller = getOrCreateController(scan.id);
  try {
    await startStage(scan.id, "dependencies");
    const report = await runDependencyAudit(scan.extractDir, { signal: controller.signal, scope: getScanScope(scan.extractDir) });
    await completeStage(scan.id, "dependencies", report);
    res.json(report);
  } catch (err) {
    if (isAbortError(err)) return res.status(200).json({ cancelled: true });
    await failStage(scan.id, "dependencies", err.message).catch(() => {});
    next(err);
  }
});

// Runs a real Sonar analysis of the uploaded codebase, submitted under the
// configured SONAR_PROJECT_KEY project, then reads back its latest results.
router.post("/:id/sonar/analyze", async (req, res, next) => {
  const scan = await requireScan(req.params.id, req.user.id).catch(next);
  if (!scan) return;
  if (scan.overallStatus === "cancelled") return res.status(409).json({ error: "This run was cancelled" });

  const controller = getOrCreateController(scan.id);
  try {
    await startStage(scan.id, "sonar");
    await runSonarAnalysis(scan.id, scan.extractDir, controller.signal, getScanScope(scan.extractDir));
    const report = await getSonarReport();
    await completeStage(scan.id, "sonar", report);
    res.json(report);
  } catch (err) {
    if (isAbortError(err)) return res.status(200).json({ cancelled: true });
    await failStage(scan.id, "sonar", err.message).catch(() => {});
    next(err);
  }
});

// Runs ESLint + tsc --noEmit + Stylelint against the extracted codebase
// using our own bundled configs (never the target's own configs, regardless
// of whether it has them). Streams real progress (install/lint/typecheck
// phases) via SSE - the dependency install + type-check step can take a
// while, same reasoning as the /explain route below.
router.post("/:id/code-quality", async (req, res) => {
  let scan;
  try {
    scan = await requireScan(req.params.id, req.user.id);
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }
  if (scan.overallStatus === "cancelled") {
    return res.status(409).json({ error: "This run was cancelled" });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const controller = getOrCreateController(scan.id);
  try {
    await startStage(scan.id, "codeQuality");
    const result = await runCodeQuality(scan, (evt) => send("progress", evt), controller.signal, getScanScope(scan.extractDir));
    await completeStage(scan.id, "codeQuality", result);
    send("done", result);
  } catch (err) {
    if (isAbortError(err)) {
      send("aborted", { cancelled: true }); // scanStore.cancelScan already recorded this
    } else {
      await failStage(scan.id, "codeQuality", err.message).catch(() => {});
      send("error", { error: err.message });
    }
  } finally {
    res.end();
  }
});

// Runs an AI reviewer against the extracted codebase for judgment-level
// issues static analysis can't catch (see services/aiCodeReview.js) - runs
// independently of the four tools above, in parallel with them on the
// frontend. Streams real progress (SSE), same pattern as /code-quality.
router.post("/:id/ai-review", async (req, res) => {
  let scan;
  try {
    scan = await requireScan(req.params.id, req.user.id);
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }
  if (scan.overallStatus === "cancelled") {
    return res.status(409).json({ error: "This run was cancelled" });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const controller = getOrCreateController(scan.id);
  try {
    await startStage(scan.id, "aiCodeReview");
    const result = await runAiCodeReview(scan, (evt) => send("progress", evt), controller.signal, getScanScope(scan.extractDir));
    await completeStage(scan.id, "aiCodeReview", result);
    send("done", result);
  } catch (err) {
    if (isAbortError(err)) {
      send("aborted", { cancelled: true });
    } else {
      await failStage(scan.id, "aiCodeReview", err.message).catch(() => {});
      send("error", { error: err.message });
    }
  } finally {
    res.end();
  }
});

// Explains and groups every finding across all four tools using our own
// tool-use agent (read-only exploration of the extracted codebase, via
// Vertex AI - see services/fastExplainer.js, no Agent SDK involved).
// Streams real progress events (SSE) as they happen instead of blocking
// silently for the whole run - each event corresponds to an actual thing the
// agent just did (file read, search, turn completed), not a simulated status.
router.post("/:id/explain", async (req, res) => {
  let scan;
  try {
    scan = await requireScan(req.params.id, req.user.id);
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }
  if (scan.overallStatus === "cancelled") {
    return res.status(409).json({ error: "This run was cancelled" });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const controller = getOrCreateController(scan.id);
  try {
    await startStage(scan.id, "explanations");
    const result = await explainIssues(scan, (evt) => send("progress", evt), controller.signal, getScanScope(scan.extractDir));
    await completeStage(scan.id, "explanations", result);
    send("done", result);
  } catch (err) {
    if (isAbortError(err)) {
      send("aborted", { cancelled: true });
    } else {
      await failStage(scan.id, "explanations", err.message).catch(() => {});
      send("error", { error: err.message });
    }
  } finally {
    res.end();
  }
});

export default router;
