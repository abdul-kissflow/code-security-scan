import { useState } from "react";
import { useNavigate, useOutletContext } from "react-router-dom";
import UploadPanel from "./UploadPanel.jsx";
import { uploadCodebase } from "../api.js";

/** The /app landing page - where a login lands, and where "Upload new codebase" in the nav goes. */
export default function UploadHome() {
  const navigate = useNavigate();
  const { refreshScans } = useOutletContext();
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);

  async function handleUpload(file) {
    setUploading(true);
    setError(null);
    try {
      const result = await uploadCodebase(file);
      await refreshScans(); // so the new scan is in the nav before we navigate to it
      navigate(`/app/scans/${result.id}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
    }
  }

  return (
    <>
      <p className="muted">
        Upload a frontend codebase to check for hardcoded secrets, vulnerable dependencies, and static analysis
        findings.
      </p>
      <UploadPanel onUploaded={handleUpload} busy={uploading} />
      {error && <p className="error-text">{error}</p>}
    </>
  );
}
