import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import HealthScore from "./HealthScore.jsx";
import Pipeline from "./Pipeline.jsx";
import AnalysisLoader from "./AnalysisLoader.jsx";
import {
  getScan,
  getHealthScore,
  abortScan,
  runSecretsScan,
  runDependencyScan,
  runSonarAnalysis,
  runCodeQualityStream,
  runAiCodeReviewStream,
  explainIssuesStream,
} from "../api.js";

const IDLE = { status: "idle" };
const POLL_MS = 2000;
const SHOW_RECOMMENDATIONS_STAGE = true;

/** Maps a persisted stage record into the local {status, data} shape every report component expects. */
function seedState(status, result) {
  if (status === "done") return { status: "done", data: result };
  if (status === "cancelled") return { status: "cancelled" };
  if (status === "error") return { status: "error", error: "This check didn't complete. Open the technical view (Shift+.) for details." };
  if (status === "running") return { status: "running", log: [] }; // already running elsewhere - see the resume-poll below
  return IDLE;
}

export default function ScanView() {
  const { id: scanId } = useParams();
  const [scan, setScan] = useState(null);
  const [notFound, setNotFound] = useState(false);
  const [secrets, setSecrets] = useState(IDLE);
  const [dependencies, setDependencies] = useState(IDLE);
  const [sonar, setSonar] = useState(IDLE);
  const [codeQuality, setCodeQuality] = useState(IDLE);
  const [aiReview, setAiReview] = useState(IDLE);
  const [explain, setExplain] = useState(IDLE);
  const [health, setHealth] = useState(null);
  const [aborting, setAborting] = useState(false);
  const controllerRef = useRef(null);

  // Hidden shortcut: the per-tool technical findings aren't on this page,
  // but are needed for audit/handoff - Shift+. opens them in a new tab.
  useEffect(() => {
    function handleKeydown(e) {
      if (!(e.shiftKey && e.code === "Period")) return;
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || document.activeElement?.isContentEditable) return;
      window.open(`/technical/${scanId}`, "_blank", "noopener");
    }
    window.addEventListener("keydown", handleKeydown);
    return () => window.removeEventListener("keydown", handleKeydown);
  }, [scanId]);

  useEffect(() => {
    let stopped = false;
    const controller = new AbortController();
    controllerRef.current = controller;

    setScan(null);
    setNotFound(false);
    setSecrets(IDLE);
    setDependencies(IDLE);
    setSonar(IDLE);
    setCodeQuality(IDLE);
    setAiReview(IDLE);
    setExplain(IDLE);
    setHealth(null);

    async function pollUntilStageSettled(stageKey, setter) {
      while (!stopped) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        if (stopped) return;
        const fresh = await getScan(scanId).catch(() => null);
        if (!fresh || stopped) return;
        const status = fresh.stageStatus[stageKey];
        if (status !== "running") {
          setter(seedState(status, fresh.results[stageKey]));
          return;
        }
      }
    }

    async function driveStage(stageKey, status, result, setter, trigger) {
      if (status === "done" || status === "error" || status === "cancelled") {
        setter(seedState(status, result));
        return;
      }
      if (status === "running") {
        // Already running from before this page load (refresh, or opened
        // from the nav while it was mid-run elsewhere) - can't re-attach to
        // whatever's driving it, so just wait for it to land in the DB.
        setter(seedState(status, result));
        await pollUntilStageSettled(stageKey, setter);
        return;
      }
      // idle - this view is the one responsible for actually starting it.
      await trigger();
    }

    async function run() {
      const initial = await getScan(scanId).catch((err) => {
        if (err.message.includes("404") || /not found/i.test(err.message)) setNotFound(true);
        return null;
      });
      if (stopped || !initial) return;
      setScan(initial);

      const s = initial.stageStatus;

      await Promise.allSettled([
        driveStage("secrets", s.secrets, initial.results.secrets, setSecrets, async () => {
          setSecrets({ status: "running" });
          try {
            const data = await runSecretsScan(scanId, controller.signal);
            if (!stopped) setSecrets({ status: "done", data });
          } catch (err) {
            if (!stopped) setSecrets(err.name === "AbortError" ? { status: "cancelled" } : { status: "error", error: err.message });
          }
        }),
        driveStage("dependencies", s.dependencies, initial.results.dependencies, setDependencies, async () => {
          setDependencies({ status: "running" });
          try {
            const data = await runDependencyScan(scanId, controller.signal);
            if (!stopped) setDependencies({ status: "done", data });
          } catch (err) {
            if (!stopped) setDependencies(err.name === "AbortError" ? { status: "cancelled" } : { status: "error", error: err.message });
          }
        }),
        driveStage("sonar", s.sonar, initial.results.sonar, setSonar, async () => {
          setSonar({ status: "running" });
          try {
            const data = await runSonarAnalysis(scanId, controller.signal);
            if (!stopped) setSonar({ status: "done", data });
          } catch (err) {
            if (!stopped) setSonar(err.name === "AbortError" ? { status: "cancelled" } : { status: "error", error: err.message });
          }
        }),
        driveStage("codeQuality", s.codeQuality, initial.results.codeQuality, setCodeQuality, async () => {
          setCodeQuality({ status: "running", log: [] });
          try {
            const data = await runCodeQualityStream(
              scanId,
              (evt) => setCodeQuality((prev) => (prev.status === "running" ? { ...prev, log: [...prev.log, evt] } : prev)),
              controller.signal
            );
            if (stopped) return;
            if (data.aborted) setCodeQuality((prev) => ({ status: "cancelled", log: prev.log }));
            else setCodeQuality((prev) => ({ status: "done", data, log: prev.log }));
          } catch (err) {
            if (!stopped) setCodeQuality((prev) => ({ status: "error", error: err.message, log: prev.log }));
          }
        }),
        driveStage("aiCodeReview", s.aiCodeReview, initial.results.aiCodeReview, setAiReview, async () => {
          setAiReview({ status: "running", log: [] });
          try {
            const data = await runAiCodeReviewStream(
              scanId,
              (evt) => setAiReview((prev) => (prev.status === "running" ? { ...prev, log: [...prev.log, evt] } : prev)),
              controller.signal
            );
            if (stopped) return;
            if (data.aborted) setAiReview((prev) => ({ status: "cancelled", log: prev.log }));
            else setAiReview((prev) => ({ status: "done", data, log: prev.log }));
          } catch (err) {
            if (!stopped) setAiReview((prev) => ({ status: "error", error: err.message, log: prev.log }));
          }
        }),
      ]);
      if (stopped) return;

      if (SHOW_RECOMMENDATIONS_STAGE) {
        // Re-fetched after every parallel stage (including AI code review)
        // has settled, so the Final Report below can fold its findings in
        // directly - see fastExplainer.js.
        const afterParallelStages = await getScan(scanId).catch(() => null);
        if (stopped || !afterParallelStages) return;
        const explainStatus = afterParallelStages.stageStatus.explanations;
        if (explainStatus === "idle") {
          startExplain(scanId, controller.signal);
        } else {
          setExplain(seedState(explainStatus, afterParallelStages.results.explanations));
          if (explainStatus === "running") await pollUntilStageSettled("explanations", setExplain);
        }
      }

      refreshHealth();
    }

    function startExplain(id, signal) {
      setExplain({ status: "running", log: [] });
      explainIssuesStream(
        id,
        (evt) => setExplain((prev) => (prev.status === "running" ? { ...prev, log: [...prev.log, evt] } : prev)),
        signal
      )
        .then((data) => {
          if (stopped) return;
          if (data.aborted) setExplain((prev) => ({ status: "cancelled", log: prev.log }));
          else setExplain((prev) => ({ status: "done", data, log: prev.log }));
        })
        .catch((err) => {
          if (!stopped) setExplain((prev) => ({ status: "error", error: err.message, log: prev.log }));
        })
        .finally(() => refreshHealth());
    }

    function refreshHealth() {
      getHealthScore(scanId)
        .then(setHealth)
        .catch(() => {});
    }

    run();
    return () => {
      stopped = true;
      controller.abort();
    };
  }, [scanId]);

  async function handleAbort() {
    setAborting(true);
    controllerRef.current?.abort(); // stop listening client-side immediately
    try {
      await abortScan(scanId);
    } catch {
      // best-effort - the scan will still show whatever state the backend landed on
    } finally {
      const fresh = await getScan(scanId).catch(() => null);
      if (fresh) {
        setScan(fresh);
        setSecrets(seedState(fresh.stageStatus.secrets, fresh.results.secrets));
        setDependencies(seedState(fresh.stageStatus.dependencies, fresh.results.dependencies));
        setSonar(seedState(fresh.stageStatus.sonar, fresh.results.sonar));
        setCodeQuality(seedState(fresh.stageStatus.codeQuality, fresh.results.codeQuality));
        setAiReview(seedState(fresh.stageStatus.aiCodeReview, fresh.results.aiCodeReview));
        setExplain(seedState(fresh.stageStatus.explanations, fresh.results.explanations));
      }
      setAborting(false);
    }
  }

  if (notFound) {
    return (
      <div className="report-card">
        <p className="error-text">Scan not found.</p>
      </div>
    );
  }
  if (!scan) {
    return <p className="muted">Loading…</p>;
  }

  const stages = [
    { key: "secrets", label: "Scanning for secrets and tokens", status: secrets.status, count: secrets.data?.totalFindings },
    { key: "dependencies", label: "Auditing dependencies for vulnerabilities", status: dependencies.status, count: dependencies.data?.aggregateSummary?.total },
    { key: "sonar", label: "Analyzing code for bugs and vulnerabilities", status: sonar.status, count: sonar.data?.issuesTotal },
    { key: "codeQuality", label: "Checking code standards and types", status: codeQuality.status, count: codeQuality.data?.totalFindings },
    { key: "aiReview", label: "Reviewing for correctness, performance, and risk", status: aiReview.status, count: aiReview.data?.findings?.length },
    ...(SHOW_RECOMMENDATIONS_STAGE
      ? [{ key: "explain", label: "Composing your report", status: explain.status, count: explain.data?.groups?.length }]
      : []),
  ];

  const anyRunning = stages.some((s) => s.status === "running");
  const analysisDone = health != null && (!SHOW_RECOMMENDATIONS_STAGE || explain.status !== "running");

  return (
    <>
      <div className="scan-meta-row">
        <p className="muted scan-meta">
          Scanned <strong>{scan.originalName}</strong> ({scan.fileCount} files) · scan id <code>{scan.id}</code>
        </p>
        {anyRunning && (
          <button type="button" className="btn-small btn-danger" onClick={handleAbort} disabled={aborting}>
            {aborting ? "Aborting…" : "Abort run"}
          </button>
        )}
      </div>
      <p className="muted scan-meta-hint">
        Tip: press <kbd>Shift</kbd> + <kbd>.</kbd> to open the full technical findings in a new tab.
      </p>

      {!analysisDone && (
        <>
          <Pipeline stages={stages} />
          <AnalysisLoader stages={stages} />
        </>
      )}
      {analysisDone && (
        <>
          {scan.overallStatus === "cancelled" ? (
            <section className="report-card aborted-banner">
              <h2>Run aborted</h2>
              <p className="muted">
                This analysis was stopped before every check finished, so there's no reliable health score for it -
                a score built from an incomplete run would be misleading. The checks that did complete before the
                abort are shown below.
              </p>
            </section>
          ) : (
            <HealthScore data={health} groups={explain.data?.groups || []} />
          )}
        </>
      )}
    </>
  );
}
