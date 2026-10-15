import { useEffect, useState } from "react";
import "../App.css";
import Tabs from "./Tabs.jsx";
import SecretsReport from "./SecretsReport.jsx";
import DependencyReport from "./DependencyReport.jsx";
import SonarReport from "./SonarReport.jsx";
import CodeQualityReport from "./CodeQualityReport.jsx";
import AiCodeReviewReport from "./AiCodeReviewReport.jsx";
import ExplainReport from "./ExplainReport.jsx";
import { getScan, explainIssuesStream } from "../api.js";

const STAGE_KEYS = ["secrets", "dependencies", "sonar", "codeQuality", "aiCodeReview", "explanations"];
const POLL_MS = 2000;
const MAX_POLLS = 150; // ~5 minutes, then stop and show whatever's there

function toStageState(result) {
  return result ? { status: "done", data: result } : { status: "running", log: [] };
}

/**
 * Standalone technical-detail page, opened in a new tab via the main app's
 * Shift+. shortcut - never linked to from the main UI. Polls the scan record
 * (no SSE re-subscription) since the underlying scans were already triggered
 * by the tab that started them; this just reflects whatever's landed so far.
 * The Final Report lives here rather than on the main Code Health page - that
 * page only needs the score and the "what do I fix" modals, not the full
 * technical listing with fix diffs and per-group JSON export.
 */
export default function TechnicalView({ scanId }) {
  const [scan, setScan] = useState(null);
  const [error, setError] = useState(null);
  const [activeStage, setActiveStage] = useState("secrets");
  const [explainOverride, setExplainOverride] = useState(null);

  useEffect(() => {
    let cancelled = false;
    let timer;
    let polls = 0;

    async function poll() {
      try {
        const data = await getScan(scanId);
        if (cancelled) return;
        setScan(data);
        polls += 1;
        const settled = STAGE_KEYS.every((k) => data.results[k] !== null);
        if (!settled && polls < MAX_POLLS) timer = setTimeout(poll, POLL_MS);
      } catch (err) {
        if (!cancelled) setError(err.message);
      }
    }
    poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [scanId]);

  function handleExplainRun() {
    setExplainOverride({ status: "running", log: [] });
    explainIssuesStream(scanId, (evt) => {
      setExplainOverride((prev) => (prev?.status === "running" ? { ...prev, log: [...prev.log, evt] } : prev));
    })
      .then((data) => {
        setExplainOverride(data.aborted ? { status: "cancelled" } : { status: "done", data });
        getScan(scanId).then(setScan).catch(() => {});
      })
      .catch((err) => setExplainOverride({ status: "error", error: err.message }));
  }

  if (error) {
    return (
      <div className="app-shell">
        <p className="error-text">{error}</p>
      </div>
    );
  }

  if (!scan) {
    return (
      <div className="app-shell">
        <p className="muted">Loading…</p>
      </div>
    );
  }

  const secrets = toStageState(scan.results.secrets);
  const dependencies = toStageState(scan.results.dependencies);
  const sonar = toStageState(scan.results.sonar);
  const codeQuality = toStageState(scan.results.codeQuality);
  const aiReview = toStageState(scan.results.aiCodeReview);
  const explain = explainOverride || toStageState(scan.results.explanations);
  const canRunExplain = [secrets, dependencies, sonar, codeQuality, aiReview].every((s) => s.status !== "running");

  const stages = [
    { key: "secrets", label: "Secrets", status: secrets.status, count: secrets.data?.totalFindings },
    { key: "dependencies", label: "Dependencies", status: dependencies.status, count: dependencies.data?.aggregateSummary?.total },
    { key: "sonar", label: "Code Analysis", status: sonar.status, count: sonar.data?.issuesTotal },
    { key: "codeQuality", label: "Code Quality", status: codeQuality.status, count: codeQuality.data?.totalFindings },
    { key: "aiReview", label: "AI Code Review", status: aiReview.status, count: aiReview.data?.findings?.length },
    { key: "explain", label: "Final Report", status: explain.status, count: explain.data?.groups?.length },
  ];

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>Technical Scan Details</h1>
        <p className="muted">
          Full findings for <strong>{scan.originalName}</strong> ({scan.fileCount} files) · scan id <code>{scan.id}</code>
        </p>
      </header>

      <Tabs stages={stages} active={activeStage} onSelect={setActiveStage} />

      {activeStage === "secrets" && <SecretsReport state={secrets} />}
      {activeStage === "dependencies" && <DependencyReport state={dependencies} />}
      {activeStage === "sonar" && <SonarReport state={sonar} />}
      {activeStage === "codeQuality" && <CodeQualityReport state={codeQuality} />}
      {activeStage === "aiReview" && <AiCodeReviewReport state={aiReview} />}
      {activeStage === "explain" && <ExplainReport state={explain} onRun={handleExplainRun} canRun={canRunExplain} />}
    </div>
  );
}
