import { useEffect } from "react";

/**
 * Generic modal - stays mounted always (visibility/opacity toggled via the
 * "open" class) so the CSS transition fires on open/close instead of the
 * content just appearing/disappearing.
 */
export default function Modal({ open, onClose, title, description, toolbar, children }) {
  useEffect(() => {
    if (!open) return;
    function handleKeydown(e) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeydown);
    return () => window.removeEventListener("keydown", handleKeydown);
  }, [open, onClose]);

  return (
    <div
      className={`modal-backdrop${open ? " open" : ""}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal">
        <div className="modal-header">
          <div>
            <h3>{title}</h3>
            {description && <p>{description}</p>}
          </div>
          <button type="button" className="modal-close" onClick={onClose}>
            &times;
          </button>
        </div>
        {toolbar && <div className="modal-toolbar">{toolbar}</div>}
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}
