Review all applicable dimensions below, concentrating on issues deterministic tools commonly miss. If something is only theoretically a problem but has no realistic impact given this codebase's actual scale and usage, do not report it. Skip a dimension entirely if there's nothing meaningful in it — do not pad findings to fill every dimension. Be strict and accurate: every finding must point at a real, specific location — never a vague "consider reviewing X" without a concrete defect.

Static review has a confidence ceiling. Every finding needs an `evidenceStatus`: use `"confirmed"` only when the source code alone proves the defect (no runtime test needed — e.g. a refresh token written to localStorage, or an origin check done by substring match). Use `"insufficient-evidence"` when it's a real structural candidate but proving it needs something you can't see from here (deployed response headers, a live network trace, server-side enforcement, a registry lookup for a package's publish date/download count). Use `"review-required"` when the code's correctness genuinely depends on a business/policy decision this review can't make. Never silently upgrade a candidate to `"confirmed"` just because it looks plausible — say exactly what evidence is missing in `requiredEvidence`.

Merge related findings before submitting: if multiple locations share the same root cause, or fixing one properly requires touching the other, report them as ONE finding with multiple entries in `occurrences` instead of near-duplicate findings. Only merge when they are genuinely the same problem or tightly coupled; do not merge findings that merely share a category or a file.

## authorization (Authorization & Access Control)
- Role/permission checks that only gate UI rendering (hidden buttons, conditional JSX, disabled menu items) with no visible corresponding server-side enforcement check on the mutating endpoint the action ultimately calls (the server-side half is unprovable from a frontend repo — emit it as an obligation, evidenceStatus "insufficient-evidence", not a confirmed vuln).
- Route guards (`<ProtectedRoute>`, router beforeEnter, framework middleware) that are the *sole* gate for a route segment — a routing-layer control is not an authorization boundary.
- Decoded JWT/session claims (`jwt-decode`, manual `atob(token.split('.')[1])`) used to branch on role/isAdmin/permissions and gate an action or API call — versus merely feeding a display (username, avatar) or a client-side expiry pre-check, which is fine. The discriminator is the *use*, not the decode.
- The same mutating action reachable from multiple UI entry points with inconsistent client-side guarding — e.g. delete gated in the list view but reachable ungated from a detail page, bulk action, or keyboard shortcut.
- IDOR-shaped patterns: an object/resource ID taken directly from a URL param, route state, or client-side list index and passed straight into a fetch call with no accompanying ownership/tenant check anywhere in the calling code path.
- For every client-gated surface, list the API calls it makes and the predicate that gates it — this cross-tier obligation framing is the deliverable even when the server can't be inspected (mark as needs-evidence; never assert the server does or doesn't enforce it).

## injection_unsafe_sinks (Injection & Unsafe Sinks, beyond generic XSS lint)
- `dangerouslySetInnerHTML` fed through a project-local wrapper (`renderMarkdown()`, `sanitizeHtml()`, `lib/html.ts`) two or more calls removed from an actual sanitizer — confirm the wrapper truly sanitizes before either flagging or clearing it.
- Sanitizer config objects (DOMPurify, sanitize-html) with a widened allowlist: `ALLOW_UNKNOWN_PROTOCOLS: true`, `ADD_ATTR` including `on*` handlers, `ADD_TAGS` including `script`/`iframe`/`style`/`form`, `SANITIZE_DOM: false`.
- Post-sanitization DOM mutation: code sanitizes an HTML string, then later mutates the resulting node or splices in additional unsanitized fragments — this silently voids the sanitization.
- Markdown/LLM-output renderers with raw HTML re-enabled: `rehype-raw` alongside `react-markdown`, `marked()` output fed into `dangerouslySetInnerHTML`, `markdown-it({ html: true })` — especially wherever the source string can include LLM output, RAG/tool-result content, or third-party API content.
- Dynamic `import()` with a non-literal specifier (`import(userPath)`, `import(\`./widgets/${name}\`)`) — a code-injection sink most lint configs don't cover.
- Navigation/redirect URLs built by string concatenation, `startsWith('/')`, or substring checks instead of `new URL(x, base)` + an origin allowlist. Test against known bypass shapes: protocol-relative `//evil.com`, backslash `\evil.com`, userinfo `trusted.com@evil`, suffix match `trusted.com.evil.com`, scheme smuggled via whitespace/case.
- Redirect/return-URL targets read back from sessionStorage/localStorage across a login redirect, or from a state container rather than directly off the URL.
- `window.open(url)` without `noopener` explicitly in the features string. Do NOT flag `<a target="_blank">` without `rel="noopener"` — modern browsers imply it, that advice is outdated.
- SVG file uploads previewed via `URL.createObjectURL` into an `<iframe>`/`srcdoc` — SVG can execute script in that rendering context.
- Uploaded filename or file metadata echoed into the DOM unescaped, or used to construct a client-side path.

## sensitive_data_exposure (Sensitive Data Exposure)
- State-persistence middleware with no field allowlist: redux-persist without a whitelist, Zustand persist middleware without `partialize`, a TanStack Query persister with no filter — these serialize the entire store, tokens and PII included, into localStorage by default.
- API responses spread wholesale into client state or storage (`setUser(response.data)`) without picking only the fields the UI needs.
- PII/financial/health-shaped field names (email, DOB, national ID, PAN, diagnosis) written to localStorage/sessionStorage/IndexedDB (directly or via Dexie/localForage) — judge by field name and shape, not by the mere presence of a storage write.
- Public-prefixed env vars with secret-shaped names: `NEXT_PUBLIC_*_SECRET`, `VITE_*_PASSWORD`, `REACT_APP_*_API_SECRET`, `*_PRIVATE_KEY` — the prefix/name mismatch alone is a near-certain true positive.
- Client-held LLM provider keys (`VITE_OPENAI_API_KEY`, `NEXT_PUBLIC_ANTHROPIC_API_KEY`) — implies open-ended cost/abuse exposure, not just a leak.
- Proprietary business logic shipped to the client: pricing/discount formulas, fraud/risk thresholds, feature-entitlement matrices, internal hostnames or service topology, admin endpoint paths — severity rises sharply if source maps are also exposed in production.
- Verbose error detail (stack traces, internal IDs, service/query names) surfaced to end users in error boundaries or toast messages, rather than a generic message.
- Logging/analytics/observability calls (`console.log`, Sentry/LogRocket breadcrumbs, `analytics.track`) that capture entire request/response payloads or full user objects instead of a redacted subset.

## auth_token_handling (Auth Token Handling)
- Refresh tokens written to localStorage/sessionStorage — treat as a hard finding. Short-lived access tokens held only in memory are acceptable; a Web/Service Worker isolating the refresh token is a recognized good pattern — don't flag it.
- Tokens written through a storage abstraction (`storage.set(K.AUTH, t)`, `authStore.persist(...)`) rather than a literal `localStorage.setItem` call — treat the wrapper's call sites as the real sink.
- A token passed in a WebSocket or SSE connection URL as a query parameter (`new WebSocket("wss://api/ws?token="+jwt)`) — leaks into proxy/access logs; the correct pattern is a short-lived ticket fetched over HTTP and redeemed on connect.
- Cookie-based token storage missing HttpOnly/Secure/SameSite wherever the app controls the cookie-setting code path.
- No visible independent server-side session/expiry enforcement — client-side expiry checks used as if they were the actual session boundary (needs server-side verification).
- Code or comments implying DPoP (or similar) fully protects against token theft in the browser — an attacker running JS in the page can mint its own DPoP proofs, so it doesn't defend against an XSS-class compromise.

## csrf_cors_postmessage (CSRF, CORS & postMessage Misuse)
- `postMessage` listeners with no `event.origin` check at all.
- `postMessage(data, '*')` — wildcard target origin.
- Origin validation via substring/prefix/suffix matching — `origin.includes('example.com')`, `.startsWith('https://app')`, `.endsWith('.example.com')` — bypassable via `evil-example.com` or `example.com.evil.net`. This is the most common real-world defect and the one teams believe is a correct check.
- Origin checks satisfiable by the literal string `"null"` (sandboxed iframe/popup origins), or reliance on `event.source` without accounting for it becoming null once the sending frame is removed from the DOM.
- Origin-check logic hidden behind an early-return guard clause (`if (!allowed) return; handle(e.data);`) — don't miss correct guard-clause implementations, and don't flag them as missing.
- Mutating fetch/axios calls using cookie-based auth (`credentials: 'include'`, `withCredentials: true`) with no anti-CSRF token header — first establish the app's auth mode; this doesn't apply to bearer-token SPAs and flagging it there is a pure false positive.
- Client-side CSRF shape: a message/hashchange/popstate listener whose data flows into a fetch/XHR URL or body — lets an attacker manipulate the page's own JS into issuing a forged request.
- `<iframe sandbox>` containing both `allow-scripts` and `allow-same-origin` together — lets the framed content remove its own sandbox.
- Overly broad iframe `allow=` (Permissions Policy) granting camera/microphone/geolocation/payment beyond what the embedded feature actually needs.

## client_crypto_randomness (Client-Side Crypto & Randomness)
- `Math.random()` (or a hand-rolled PRNG) whose output flows into a binding named like token/nonce/id/key/salt/otp/csrf — gate this on the *name* of what it produces, not on presence (most `Math.random()` calls are benign: React key props, jitter, sampling, cache-busting).
- Hand-rolled "encryption" (XOR ciphers, custom base64 obfuscation) presented in code or comments as a real security control rather than acknowledged as mere encoding.

## websocket_realtime (WebSocket / Realtime)
- `ws://` (non-TLS) WebSocket URLs outside of dev/test configuration.
- Client code that assumes the browser enforces same-origin on WebSocket/SSE connections — it doesn't; origin checking is a server-side obligation (needs server-side verification).

## supply_chain_beyond_cves (Supply Chain Beyond npm audit's CVE Coverage)
Do not repeat known CVEs — npm audit already covers those.
- New or changed lifecycle scripts in a lockfile/package.json diff — check `preinstall`, `install`, `postinstall`, `prepare`, `prepack`.
- Lockfile entries where a resolved/resolution URL points at a non-standard registry host, loses its integrity hash, or resolves to a `git:`/`http:`/`file:` dependency instead of the registry.
- Any newly added dependency: name similarity to a popular package (typosquatting), a repository field claiming a well-known project's URL (starjacking), or a public package name that shadows what looks like an internal/scoped name (dependency confusion). Note when confirming download counts/publish dates would need a registry lookup (evidenceStatus insufficient-evidence) but still surface the red flag.
- A dependency version pinned to `*`, `latest`, or a bare git URL/branch ref rather than a semver range or exact pin.
- A package flagged deprecated in registry metadata, or with a long gap since its last release plus open critical issues, still present as a production dependency.
- Production code importing from devDependencies/optionalDependencies.

