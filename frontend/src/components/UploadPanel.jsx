import { useRef, useState } from "react";

export default function UploadPanel({ onUploaded, busy }) {
  const inputRef = useRef(null);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState(null);

  function handleFile(file) {
    setError(null);
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".zip")) {
      setError("Please choose a .zip file containing the codebase.");
      return;
    }
    onUploaded(file);
  }

  return (
    <div
      className={`upload-panel ${dragOver ? "drag-over" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        handleFile(e.dataTransfer.files?.[0]);
      }}
    >
      <p className="upload-title">Upload a frontend codebase (.zip)</p>
      <p className="upload-hint">Drag & drop, or click to choose a file. Scanning runs entirely on the server.</p>
      <button className="btn" disabled={busy} onClick={() => inputRef.current?.click()}>
        {busy ? "Working…" : "Choose zip file"}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept=".zip"
        hidden
        onChange={(e) => handleFile(e.target.files?.[0])}
      />
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}
