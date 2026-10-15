// Ported from an internal AI-plugin repo's scan-engine/config/known-benign-paths.mjs. Paths are
// matched relative to the detected project root (see src/services/projectProfile.js), and applied
// to every upload: secrets output, AI-review tool access, and Sonar exclusions.
//
// CANONICAL COPY of scaffold paths/patterns that are known ahead of time to be benign despite
// matching a scan rule shaped like a real risk - re-sync when the scaffold's own fixed
// infrastructure changes, same "edit here, not in an app" discipline as config/baseline-deps.mjs.
//
// TWO DIFFERENT REASONS something ends up on this list - do not conflate them:
//
// 1. cert/ — NEVER a real secret, regardless of content. starter/cert/localhost.{key,crt} is the
//    scaffold's self-signed local-dev HTTPS certificate (starter/vite.config.js's `server.https` -
//    the Vite DEV SERVER's TLS listener only). Verified directly: never read by anything in the
//    client build graph, and scripts/zip.js zips ONLY `dist/` - the cert never enters the bundle a
//    real user's browser downloads. betterleaks has no way to know that from content alone - a
//    private-key PEM block looks identical whether it's a real leaked key or a throwaway localhost
//    cert - so it correctly (from its own rules) flags it as CRITICAL every single time, on every
//    app this pipeline builds, capping the security pillar at <=39 for a risk that doesn't exist.
//
// 2. .env files — the OPPOSITE reasoning: these genuinely DO hold real secrets (KF_ACCESS_KEY_ID/
//    KF_ACCESS_KEY_SECRET, per starter/.env.example - real admin API credentials `kf:sync` writes
//    there during a real build), but that is the CORRECT, expected place for them - a `KEY=value`
//    line in `.env` is configuration, not a leak. This plugin is used by non-technical people who
//    would not otherwise know a hardcoded secret belongs in `.env` rather than pasted straight into
//    a page component - flagging the properly-configured `.env` as a "finding needing a decision"
//    on every single build trains them to expect and dismiss that finding, which is exactly the
//    failure mode that would let a REAL problem (a third-party API key hardcoded directly in
//    application source, `.jsx`/`.js`) blend into routine noise instead of standing out. Excluding
//    `.env` is what keeps the secrets stage's decision-required bucket meaningful for the case that
//    actually matters: a credential sitting in the application's own source code, not in the one
//    file whose entire job is holding credentials. Application source stays scanned in full,
//    unscoped, exactly as before - only the env file itself is excluded, never a directory.
//    `.env.example` is deliberately NOT excluded by the pattern below (it's always blank in this
//    scaffold, so it's moot either way, but excluding it too would be excluding a file that's
//    supposed to have nothing real in it, not one that's supposed to).
//
// SCOPED TO THE WHOLE cert/ DIRECTORY (not just the two known files today) - this folder's only job
// in the scaffold is holding the local-dev cert pair, so excluding the directory is no wider than
// excluding the files, and covers a future addition (e.g. cert/localhost.pem) without this list
// needing an update too.
//
// LIMITATION, not fixed: both of these are path/name-based exclusions, not content-based. cert/
// does not distinguish "the scaffold's own cert" from "someone accidentally added a REAL private
// key under cert/ too" - a path match is a path match, and cert/ has never held anything else in
// practice. Similarly, an `.env` match assumes the file is used as documented (admin keys, dev-only,
// never read by client code - verified in starter/vite.config.js and the absence of any
// `import.meta.env` usage in src/); it does not re-verify that per scan.

export const KNOWN_BENIGN_PATH_PREFIXES = ["cert/"];

// Matches `.env`, `.env.local`, `.env.production`, etc. (any dotted suffix) at any depth in the
// tree - but NOT `.env.example`, which is meant to stay a harmless, blank template.
const ENV_FILE_RE = /(^|\/)\.env(\.(?!example$)[^/]+)?$/;

export function isKnownBenignPath(relPath) {
  const normalized = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (ENV_FILE_RE.test(normalized)) return true;
  return KNOWN_BENIGN_PATH_PREFIXES.some((prefix) => normalized === prefix.replace(/\/$/, "") || normalized.startsWith(prefix));
}
