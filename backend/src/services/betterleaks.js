import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isBenignScanPath } from "./projectProfile.js";

const BETTERLEAKS_BIN = process.env.BETTERLEAKS_BIN || "betterleaks";

function severityForRule(finding) {
  // betterleaks findings don't carry an explicit severity; derive a rough
  // one from the rule id so the UI can sort/highlight sensibly.
  const id = (finding.RuleID || finding.ruleID || "").toLowerCase();
  if (id.includes("private-key") || id.includes("aws") || id.includes("gcp") || id.includes("azure")) {
    return "critical";
  }
  if (id.includes("generic-api-key") || id.includes("token") || id.includes("secret")) {
    return "high";
  }
  return "medium";
}

/**
 * Runs `betterleaks dir` against targetDir and returns a normalized,
 * human-readable report. Secret values themselves are never returned raw -
 * betterleaks redaction is used so we display matches safely.
 *
 * The scan itself is always the whole directory (a secret in an unused file is
 * still a leak in source control); only the OUTPUT is filtered against
 * config/known-benign-paths.js (.env files, the scaffold's cert/), and every
 * exclusion is recorded, never silent - same as the ai-plugin scan-engine.
 */
export function runBetterleaks(targetDir, { signal, scope } = {}) {
  return new Promise((resolve, reject) => {
    const reportPath = path.join(os.tmpdir(), `betterleaks-${randomUUID()}.json`);

    execFile(
      BETTERLEAKS_BIN,
      [
        "dir",
        targetDir,
        "--report-format",
        "json",
        "--report-path",
        reportPath,
        "--redact",
        "--no-banner",
        "--no-color",
        "--exit-code",
        "2",
      ],
      { maxBuffer: 1024 * 1024 * 64, timeout: 5 * 60 * 1000, signal },
      (error, stdout, stderr) => {
        if (error?.name === "AbortError") return reject(error);
        if (error && error.code === "ENOENT") {
          return reject(new Error(`betterleaks binary not found (looked for "${BETTERLEAKS_BIN}"). Install it with "brew install betterleaks".`));
        }

        // Exit code 2 means "leaks found" (we requested it via --exit-code),
        // exit 0 means "no leaks found" - both are successful runs. Any
        // other non-zero code is a real execution failure.
        const reportExists = fs.existsSync(reportPath);
        if (error && error.code !== 2 && !reportExists) {
          return reject(new Error(`betterleaks failed: ${stderr || error.message}`));
        }

        try {
          let findings = [];
          if (reportExists) {
            const raw = fs.readFileSync(reportPath, "utf8").trim();
            // betterleaks writes the literal JSON value "null" when no leaks are found.
            const parsed = raw ? JSON.parse(raw) : null;
            findings = Array.isArray(parsed) ? parsed : [];
            fs.unlinkSync(reportPath);
          }

          const allNormalized = findings.map((f) => ({
            rule: f.RuleID || f.ruleID || "unknown-rule",
            description: f.Description || f.description || "",
            file: path.relative(targetDir, f.File || f.file || "") || f.File || f.file || "",
            line: f.StartLine ?? f.startLine ?? null,
            match: f.Match || f.match || "",
            secretRedacted: f.Secret || f.secret || "",
            severity: severityForRule(f),
            commit: f.Commit || f.commit || null,
            author: f.Author || f.author || null,
          }));

          const normalized = allNormalized.filter((f) => !isBenignScanPath(f.file, scope));
          const excludedKnownBenign = allNormalized.filter((f) => isBenignScanPath(f.file, scope));

          resolve({
            tool: "betterleaks",
            scannedAt: new Date().toISOString(),
            totalFindings: normalized.length,
            findings: normalized,
            excludedKnownBenignCount: excludedKnownBenign.length,
            excludedKnownBenignPaths: [...new Set(excludedKnownBenign.map((f) => f.file))],
          });
        } catch (parseErr) {
          reject(new Error(`Failed to parse betterleaks report: ${parseErr.message}`));
        }
      }
    );
  });
}
