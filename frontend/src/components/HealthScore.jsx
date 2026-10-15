import { useState } from "react";
import Modal from "./Modal.jsx";
import CopyJsonButton from "./CopyJsonButton.jsx";
import GroupCard from "./GroupCard.jsx";

const STATUS_COLOR = {
  Healthy: "var(--success)",
  "Needs Attention": "var(--warning)",
  Poor: "var(--poor)",
  Critical: "var(--danger)",
  Incomplete: "var(--muted)",
};

const HEADLINE = {
  Critical: "This codebase needs urgent care.",
  Poor: "Getting there, but not healthy yet.",
  "Needs Attention": "So close — just a few fixes to go.",
  Healthy: "Nice work — you're in the healthy zone.",
  Incomplete: "This score isn't final — part of the scan failed.",
};

// Categories, named directly - never surfaced to the user as "pillars".
const CATEGORIES = [
  { key: "security", name: "Security", weight: 0.5 },
  { key: "reliability", name: "Stability", weight: 0.3 },
  { key: "maintainability", name: "Maintainability", weight: 0.2 },
];

function buildStatusMessage({ label, count, isHealthy, topCategoryNames }) {
  const headline = HEADLINE[label] || HEADLINE.Poor;
  if (count === 0) {
    return {
      headline,
      detail: isHealthy
        ? "Nothing left to fix — a perfect score."
        : "Nothing currently blocking you.",
    };
  }
  const countPhrase = `${count} issue${count === 1 ? "" : "s"}`;
  if (isHealthy) {
    return {
      headline,
      detail: `${countPhrase} left before you hit a perfect 100. Keep pushing.`,
    };
  }
  const mainly =
    topCategoryNames.length > 0
      ? ` — mostly ${topCategoryNames.join(" and ").toLowerCase()}`
      : "";
  return {
    headline,
    detail: `${countPhrase} ${count === 1 ? "is" : "are"} holding you back${mainly}.`,
  };
}

function CategoryCard({ name, pillar, share, count, index, onViewIssues }) {
  const color = STATUS_COLOR[pillar.label] || "var(--muted)";
  return (
    <div className="category-card" style={{ "--i": index }}>
      <div className="category-card-head">
        <span className="category-name">{name}</span>
        <span className="category-score" style={{ color }}>
          {pillar.score}%
        </span>
      </div>
      <div className="category-track">
        <div style={{ "--fill": `${pillar.score}%`, background: color }} />
      </div>
      <p className="category-contribution">
        {share > 0 ? (
          <>
            Costing you <b>{share}%</b> of your lost points.
          </>
        ) : (
          `${pillar.label} — no significant issues found.`
        )}
      </p>
      {count > 0 && (
        <button
          type="button"
          className="category-view-btn"
          onClick={onViewIssues}
        >
          See the {count} issue{count === 1 ? "" : "s"}{" "}
          <span className="arrow">→</span>
        </button>
      )}
    </div>
  );
}

/**
 * `groups` is the Final Report's explained issue groups - the modals here
 * show the same plain-language groups ExplainReport does, just pre-filtered,
 * so "see the issues" never means jumping out to raw technical findings.
 */
export default function HealthScore({ data, groups = [] }) {
  const [modal, setModal] = useState(null); // null | "target" | a category key

  if (!data) return null;

  const color = STATUS_COLOR[data.label] || "var(--muted)";
  const incompleteStages = data.incompleteStages || [];
  // A failed stage contributes no findings, so the number can only be too high - never call it healthy.
  const isHealthy = data.overall >= 80 && incompleteStages.length === 0;
  const target = isHealthy ? 100 : 80;

  // "Reach 80": the groups actually capping the score (SERIOUS/MAJOR bucket -
  // see healthScore.js's hard-cap rule). If none exist but the score is
  // still under 80 (a pile of minor findings did it, rare but possible),
  // fall back to everything open rather than showing an empty "fix nothing".
  const cappingGroups = groups.filter(
    (g) => g.bucket === "SERIOUS" || g.bucket === "MAJOR",
  );
  const targetGroups = isHealthy
    ? groups
    : cappingGroups.length > 0
      ? cappingGroups
      : groups;

  const categoryGroups = {};
  const losses = {};
  let totalLoss = 0;
  for (const cat of CATEGORIES) {
    categoryGroups[cat.key] = groups.filter((g) => g.pillar === cat.key);
    const loss = cat.weight * (100 - data.pillars[cat.key].score);
    losses[cat.key] = loss;
    totalLoss += loss;
  }
  const topCategoryNames = [...CATEGORIES]
    .filter((cat) => losses[cat.key] > 0)
    .sort((a, b) => losses[b.key] - losses[a.key])
    .slice(0, 2)
    .map((cat) => cat.name);

  const message = buildStatusMessage({
    label: data.label,
    count: targetGroups.length,
    isHealthy,
    topCategoryNames,
  });

  const modalConfig =
    modal === "target"
      ? {
          title: `${targetGroups.length} issue${targetGroups.length === 1 ? "" : "s"} standing between you and ${target}`,
          description:
            "These are the ones actually holding your score down — fix these first.",
          groups: targetGroups,
        }
      : modal
        ? {
            title: `${CATEGORIES.find((c) => c.key === modal).name} — ${categoryGroups[modal].length} issue${categoryGroups[modal].length === 1 ? "" : "s"}`,
            description: `Everything currently pulling your ${CATEGORIES.find((c) => c.key === modal).name.toLowerCase()} score down.`,
            groups: categoryGroups[modal],
          }
        : null;

  return (
    <section className="health-card">
      <p className="health-eyebrow">Code health</p>

      <div className="health-score-hero">
        <div
          className="health-score-ring"
          style={{
            "--health-score": data.overall,
            "--health-score-color": color,
          }}
        >
          <div className="health-score-ring-inner">
            <span className="health-score-number">
              {data.overall}
              <span className="health-score-pct">%</span>
            </span>
          </div>
        </div>
        <p className="health-score-label" style={{ color }}>
          {data.label}
        </p>
        <p className="health-threshold-line">
          Score <b>80</b> or higher to become healthy codebase.
        </p>
      </div>

      {incompleteStages.length > 0 && (
        <p className="warn-text">
          Not counted because they failed:{" "}
          {incompleteStages.map((s) => s.reason).join("; ")}. The real score may
          be lower — rerun the scan once these succeed.
        </p>
      )}

      <div
        className="health-status-message"
        style={{ "--status-color": color }}
      >
        <span className="health-status-icon">{isHealthy ? "✓" : "⚠"}</span>
        <div>
          <p>{message.headline}</p>
          <p className="muted">{message.detail}</p>
        </div>
      </div>

      {targetGroups.length > 0 && (
        <div className="health-target-cta">
          <div className="health-target-cta-text">
            Fix <strong>{targetGroups.length}</strong> issue
            {targetGroups.length === 1 ? "" : "s"} to{" "}
            {isHealthy ? "reach a perfect" : "cross"} <strong>{target}</strong>.
          </div>
          <button
            type="button"
            className="btn"
            onClick={() => setModal("target")}
          >
            {isHealthy ? "Show me what's left" : "Show me what's blocking me"}
          </button>
        </div>
      )}

      <h3 className="health-section-heading">
        Where your score is coming from
      </h3>
      <div className="category-grid">
        {CATEGORIES.map((cat, i) => (
          <CategoryCard
            key={cat.key}
            name={cat.name}
            pillar={data.pillars[cat.key]}
            share={
              totalLoss > 0
                ? Math.round((losses[cat.key] / totalLoss) * 100)
                : 0
            }
            count={categoryGroups[cat.key].length}
            index={i}
            onViewIssues={() => setModal(cat.key)}
          />
        ))}
      </div>

      <Modal
        open={modal != null}
        onClose={() => setModal(null)}
        title={modalConfig?.title}
        description={modalConfig?.description}
        toolbar={
          modalConfig && modalConfig.groups.length > 0 ? (
            <CopyJsonButton groups={modalConfig.groups} />
          ) : null
        }
      >
        {modalConfig?.groups.length === 0 && (
          <p className="muted">No issues here.</p>
        )}
        {modalConfig?.groups.map((g, i) => (
          <GroupCard key={i} group={g} />
        ))}
      </Modal>
    </section>
  );
}
