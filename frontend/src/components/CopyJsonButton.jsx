import { useState } from "react";
import { toAgentPayload } from "../agentPayload.js";

/** Copies every group's fix payload as one JSON array - same shape CopyGroupJsonButton copies for a single group. */
export default function CopyJsonButton({ groups, label = "Copy all as JSON (for automation)" }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn-small"
      onClick={() => {
        navigator.clipboard.writeText(JSON.stringify(groups.map(toAgentPayload), null, 2));
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? "Copied" : label}
    </button>
  );
}

export function CopyGroupJsonButton({ group }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn-small"
      onClick={() => {
        navigator.clipboard.writeText(JSON.stringify(toAgentPayload(group), null, 2));
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? "Copied" : "Copy as JSON"}
    </button>
  );
}
