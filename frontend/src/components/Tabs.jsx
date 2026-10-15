export default function Tabs({ stages, active, onSelect }) {
  return (
    <div className="tab-bar" role="tablist">
      {stages.map((s) => (
        <button
          key={s.key}
          type="button"
          role="tab"
          aria-selected={active === s.key}
          className={`tab-bar-tab${active === s.key ? " active" : ""}`}
          onClick={() => onSelect(s.key)}
        >
          {s.label}
          {typeof s.count === "number" && s.status === "done" && (
            <span className="tab-bar-count">{s.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}
