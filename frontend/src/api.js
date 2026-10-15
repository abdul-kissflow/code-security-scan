const BASE = "/api";

async function asJson(res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return body;
}

/**
 * Streams real progress events (SSE) from a POST endpoint, calling
 * onProgress for every "progress" event and resolving with the "done"
 * event's payload (or { aborted: true } for "aborted"). Shared by any
 * long-running stage that reports live status instead of blocking silently
 * until it finishes. `signal` lets the caller stop listening client-side
 * (e.g. on an abort click) independently of the backend's own cancellation.
 */
async function streamSSE(url, onProgress, signal) {
  const res = await fetch(url, { method: "POST", signal });
  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let frameEnd;
    while ((frameEnd = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, frameEnd);
      buffer = buffer.slice(frameEnd + 2);

      const eventLine = frame.split("\n").find((l) => l.startsWith("event: "));
      const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
      if (!dataLine) continue;

      const event = eventLine ? eventLine.slice("event: ".length) : "message";
      const data = JSON.parse(dataLine.slice("data: ".length));

      if (event === "progress") onProgress(data);
      else if (event === "error") throw new Error(data.error);
      else if (event === "aborted") return { aborted: true };
      else if (event === "done") return data;
    }
  }

  throw new Error("Stream ended without a result");
}

// --- Auth -------------------------------------------------------------

export async function devLogin(email, name) {
  const res = await fetch(`${BASE}/auth/dev-login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, name }),
  });
  return asJson(res);
}

export async function getMe() {
  const res = await fetch(`${BASE}/auth/me`);
  if (res.status === 401) return null;
  return asJson(res);
}

export async function logout() {
  const res = await fetch(`${BASE}/auth/logout`, { method: "POST" });
  return asJson(res);
}

// --- Scans --------------------------------------------------------------

export async function uploadCodebase(file) {
  const form = new FormData();
  form.append("codebase", file);

  const res = await fetch(`${BASE}/scans`, { method: "POST", body: form });
  return asJson(res);
}

/** The current user's scans, for the left nav. */
export async function getScans() {
  const res = await fetch(`${BASE}/scans`);
  return asJson(res);
}

export async function getScan(scanId) {
  const res = await fetch(`${BASE}/scans/${scanId}`);
  return asJson(res);
}

export async function getHealthScore(scanId) {
  const res = await fetch(`${BASE}/scans/${scanId}/health`);
  return asJson(res);
}

/** Stops the whole run - every in-flight or queued stage, not just one. */
export async function abortScan(scanId) {
  const res = await fetch(`${BASE}/scans/${scanId}/abort`, { method: "POST" });
  return asJson(res);
}

export async function runSecretsScan(scanId, signal) {
  const res = await fetch(`${BASE}/scans/${scanId}/secrets`, { method: "POST", signal });
  return asJson(res);
}

export async function runDependencyScan(scanId, signal) {
  const res = await fetch(`${BASE}/scans/${scanId}/dependencies`, { method: "POST", signal });
  return asJson(res);
}

export async function runSonarAnalysis(scanId, signal) {
  const res = await fetch(`${BASE}/scans/${scanId}/sonar/analyze`, { method: "POST", signal });
  return asJson(res);
}

export async function runCodeQualityStream(scanId, onProgress, signal) {
  return streamSSE(`${BASE}/scans/${scanId}/code-quality`, onProgress, signal);
}

/**
 * Streams real progress events from the explain endpoint (SSE) as the agent
 * actually does each step, calling onProgress for every real event and
 * resolving with the final result once the "done" event arrives.
 */
export async function explainIssuesStream(scanId, onProgress, signal) {
  return streamSSE(`${BASE}/scans/${scanId}/explain`, onProgress, signal);
}

export async function runAiCodeReviewStream(scanId, onProgress, signal) {
  return streamSSE(`${BASE}/scans/${scanId}/ai-review`, onProgress, signal);
}
