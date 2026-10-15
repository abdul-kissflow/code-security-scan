const STATUS_ICON = { idle: "", running: "", done: "✓", error: "✕", cancelled: "⊘" };

/** Small, non-interactive status strip - just shows where the run stands. */
export default function Pipeline({ stages }) {
  return (
    <div className="pipeline-mini">
      {stages.map((s, i) => (
        <div key={s.key} className="pipeline-mini-step">
          <span className={`pipeline-mini-dot dot-${s.status}`}>{STATUS_ICON[s.status]}</span>
          <span className="pipeline-mini-label">{s.label}</span>
          {i < stages.length - 1 && <span className={`pipeline-mini-connector conn-${s.status}`} />}
        </div>
      ))}
    </div>
  );
}
