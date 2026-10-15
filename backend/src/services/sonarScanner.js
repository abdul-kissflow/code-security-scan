import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SCANNER_BIN = process.env.SONAR_SCANNER_BIN || "sonar-scanner";
const CE_POLL_INTERVAL_MS = 2000;
const CE_POLL_TIMEOUT_MS = 5 * 60 * 1000;

function baseUrl() {
  const url = process.env.SONAR_URL;
  if (!url) throw Object.assign(new Error("SONAR_URL is not set on the server (.env)"), { status: 500 });
  return url;
}

function analysisToken() {
  const token = process.env.SONAR_ANALYSIS_TOKEN;
  if (!token) throw Object.assign(new Error("SONAR_ANALYSIS_TOKEN is not set on the server (.env)"), { status: 500 });
  return token;
}

function projectKey() {
  const key = process.env.SONAR_PROJECT_KEY;
  if (!key) throw Object.assign(new Error("SONAR_PROJECT_KEY is not set on the server (.env)"), { status: 500 });
  return key;
}

function authHeader(token) {
  return "Basic " + Buffer.from(`${token}:`).toString("base64");
}

function makeAbortError() {
  const err = new Error("Aborted");
  err.name = "AbortError";
  return err;
}

/** setTimeout that rejects immediately (or right away if already aborted) when signal fires. */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(makeAbortError());
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(makeAbortError());
      },
      { once: true }
    );
  });
}

async function sonarGet(pathAndQuery, token, signal) {
  const res = await fetch(`${baseUrl()}${pathAndQuery}`, { headers: { Authorization: authHeader(token) }, signal });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body?.errors?.map((e) => e.msg).join("; ") || res.statusText;
    throw new Error(`Sonar API GET ${pathAndQuery} failed: ${msg}`);
  }
  return body;
}

function scannerArgs(targetDir, workDir, scope) {
  // cert/ and .env files: same known-benign list the secrets stage filters on (config/known-
  // benign-paths.js) - Sonar has its own secret rules and would otherwise flag the identical files.
  const certDir = scope?.projectRoot ? `${scope.projectRoot}/cert/**` : "cert/**";
  const args = [
    `-Dsonar.projectKey=${projectKey()}`,
    `-Dsonar.sources=${targetDir}`,
    `-Dsonar.host.url=${baseUrl()}`,
    `-Dsonar.token=${analysisToken()}`,
    `-Dsonar.working.directory=${workDir}`,
    "-Dsonar.scm.disabled=true",
    `-Dsonar.exclusions=**/node_modules/**,**/dist/**,**/build/**,**/coverage/**,**/.next/**,${certDir},**/.env,**/.env.*`,
  ];
  // Kissflow starter apps: analyze only what the app imports (see projectProfile.js).
  if (scope?.files?.length) args.push(`-Dsonar.inclusions=${scope.files.join(",")}`);
  return args;
}

function runScannerCli(targetDir, workDir, scope, signal) {
  return new Promise((resolve, reject) => {
    execFile(
      SCANNER_BIN,
      scannerArgs(targetDir, workDir, scope),
      { cwd: targetDir, maxBuffer: 1024 * 1024 * 64, timeout: 10 * 60 * 1000, signal },
      (error, stdout, stderr) => {
        if (error?.name === "AbortError") return reject(error);
        if (error) return reject(new Error(`sonar-scanner failed: ${stderr || stdout || error.message}`));
        resolve(stdout);
      }
    );
  });
}

function readCeTaskId(workDir) {
  const reportPath = path.join(workDir, "report-task.txt");
  if (!fs.existsSync(reportPath)) {
    throw new Error("sonar-scanner did not produce report-task.txt - analysis may not have been submitted");
  }
  const lines = fs.readFileSync(reportPath, "utf8").split("\n");
  const entry = lines.find((l) => l.startsWith("ceTaskId="));
  if (!entry) throw new Error("report-task.txt did not contain a ceTaskId");
  return entry.split("=")[1].trim();
}

async function waitForCeTask(ceTaskId, signal) {
  const deadline = Date.now() + CE_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw makeAbortError();
    const body = await sonarGet(`/api/ce/task?id=${encodeURIComponent(ceTaskId)}`, analysisToken(), signal);
    const status = body.task?.status;
    if (status === "SUCCESS") return;
    if (status === "FAILED" || status === "CANCELED") {
      throw new Error(`Sonar background analysis task ${status.toLowerCase()}: ${body.task?.errorMessage || "no error message"}`);
    }
    await sleep(CE_POLL_INTERVAL_MS, signal);
  }
  throw new Error("Timed out waiting for Sonar background analysis task to complete");
}

/**
 * Runs a real sonar-scanner analysis of the uploaded codebase, submitted
 * under the existing, pre-configured SONAR_PROJECT_KEY project (not an
 * isolated per-scan project). Uses SONAR_ANALYSIS_TOKEN
 * only to execute the scan; reading the resulting report is left to
 * services/sonar.js (SONAR_TOKEN), which reads the same project.
 */
export async function runSonarAnalysis(scanId, targetDir, signal, scope) {
  const workDir = path.join(os.tmpdir(), `sonar-work-${scanId}`);
  fs.mkdirSync(workDir, { recursive: true });

  try {
    await runScannerCli(targetDir, workDir, scope, signal);
    const ceTaskId = readCeTaskId(workDir);
    await waitForCeTask(ceTaskId, signal);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}
