// One AbortController per scan, shared by every stage's execFile/HTTP call
// for that scan - calling .abort() once stops everything currently running
// for that scan together, not stage by stage. In-memory, so (like
// npmLock.js) this assumes a single backend process; fine at today's scale.
const controllers = new Map();

export function getOrCreateController(scanId) {
  if (!controllers.has(scanId)) controllers.set(scanId, new AbortController());
  return controllers.get(scanId);
}

export function abortScan(scanId) {
  controllers.get(scanId)?.abort();
}

export function clearController(scanId) {
  controllers.delete(scanId);
}

export function isAbortError(err) {
  return err?.name === "AbortError";
}
