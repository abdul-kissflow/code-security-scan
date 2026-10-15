# FE Codebase Security & Quality Scanner

Upload a frontend codebase (`.zip`) and get five reports, run as a pipeline:

1. **Hardcoded secrets/tokens** — [betterleaks](https://github.com/betterleaks/betterleaks)
2. **Vulnerable dependencies** — `npm audit` against every `package.json` found in the zip
3. **Static analysis** — a real SonarQube analysis, via `sonar-scanner`
4. **Code quality** — ESLint + TypeScript (`tsc --noEmit`) + Stylelint, against our own fixed configs
5. **AI-generated explanations & fixes** — a custom tool-use agent (Claude via Vertex AI) that groups every finding from the four stages above, explains each, and produces a machine-applicable fix

Everything below explains not just what each piece does, but *why it's built this way* — most of these shapes came from a real constraint or a bug found while building it, not a first guess.

---

## Why a backend exists at all

Unzipping files, spawning `betterleaks`/`npm`/`sonar-scanner`/`eslint`/`tsc`/`stylelint`, and calling SonarQube/Vertex AI with secret tokens can't happen in browser JS — a static React app can't touch the filesystem or hide tokens from anyone viewing page source. So this is two apps:

- `backend/` — Node/Express. Does all the scanning. Holds every token server-side only (`.env`, gitignored).
- `frontend/` — React (Vite). Talks to the backend over `/api/*`, renders results.

## Setup

```bash
# 1. Install scanning tools
brew install betterleaks sonar-scanner

# 2. GCP auth for the AI explain stage (one-time, opens a browser)
gcloud auth application-default login

# 3. Backend
cd backend
cp .env.example .env   # fill in the Sonar tokens and ANTHROPIC_VERTEX_PROJECT_ID
npm install            # also installs eslint/typescript/stylelint + plugins - see "Code Quality stage"
npm run dev             # http://localhost:4000

# 4. Frontend (separate terminal)
cd frontend
npm install
npm run dev              # http://localhost:5173, proxies /api -> :4000
```

Open http://localhost:5173, upload a `.zip`. Secrets, Dependencies, Sonar, and Code Quality all kick off in parallel on upload; once every one of them settles, the AI Explain stage triggers automatically.

---

## The pipeline, stage by stage

### 1. Secrets — `betterleaks`

Runs `betterleaks dir` against the extracted zip (`backend/src/services/betterleaks.js`). betterleaks is the actively-maintained successor to `gitleaks`, built by the same author — confirmed via web search when the name was first floated, since it's easy to mistake for a typo. Its findings are read-only; nothing here mutates the uploaded codebase.

### 2. Dependencies — `npm audit`

`backend/src/services/npmAudit.js` walks the extracted tree for every `package.json` (skipping `node_modules`/`.git`/etc.), and for each one:
- If a `package-lock.json` already exists, runs `npm audit` directly.
- If not, runs `npm install --package-lock-only --ignore-scripts` first (resolves versions into a lockfile *without* downloading/installing packages or running install scripts), then audits.

`--ignore-scripts` matters: an uploaded `package.json` is untrusted input, and pre/postinstall hooks are arbitrary code execution. This is the same reasoning behind every other install in this project (see the Code Quality stage below).

### 3. Static analysis — SonarQube

`backend/src/services/sonarScanner.js` runs a **real** `sonar-scanner` analysis of the uploaded codebase — not a cached/stale read of some existing project. Every upload is submitted under one **existing** Sonar project (`SONAR_PROJECT_KEY`) on your Sonar server (`SONAR_URL`), not an isolated per-scan project.

**Why not an isolated project per scan (the obvious safer design)?** That was the original plan — see "Sonar project lifecycle" below for why it was reverted.

**Token split, still least-privilege even without project isolation:**
- `SONAR_TOKEN` — read-only, used only to fetch measures/issues/quality-gate after analysis (`backend/src/services/sonar.js`)
- `SONAR_ANALYSIS_TOKEN` — used only to *execute* `sonar-scanner`

**Reading results** (`backend/src/services/sonar.js`) paginates through *every* open issue (bug/vulnerability/code smell, all severities) — Sonar caps `issues/search` at 500 per page, and a real project can easily have thousands of open issues, so a naive single-page fetch silently truncates. `fetchAllIssues()` loops pages until it has them all (capped at 20 pages / 10,000 issues as a runaway guard).

#### Sonar project lifecycle — what was tried, and why it changed

This went through three designs in order, each abandoned for a concrete reason:

1. **Ephemeral project per scan** (`fe-scan-<scanId>`), with a provisioning token that creates the project and mints a narrowly-scoped `PROJECT_ANALYSIS_TOKEN` for just that project, used only to run the scan, then revoked. This is the textbook least-privilege design. **Reverted** because the provisioning account had no delete/admin rights on the Sonar server at all (`projects/delete` → 403, even on a project it just created itself) — every scan would permanently accumulate an orphaned project with no cleanup path, cluttering the Sonar server.
2. **Reused fixed project** (`SONAR_PROJECT_KEY`) for every upload — the current design. Confirmed to work end-to-end, including a live test where a 3-line test repo really did overwrite the project's real metrics (`ncloc` dropped to 3) until its regular CI next ran and restored them. This is a known, accepted tradeoff: **every upload through this tool temporarily overwrites the configured project's live Sonar dashboard** until its next real CI run — so point it at a dedicated scratch project if you can.
3. A read-only path that just *fetches* the project's latest results without running a new analysis still exists in `sonar.js` for reference, but isn't wired to any route.

### 4. Code Quality — ESLint + TypeScript + Stylelint

`backend/src/services/codeQuality.js`, configs in `backend/config/`. This is the newest stage and the one with the most deliberate design decisions, all stemming from one instruction: **our fixed rules, always — never the target codebase's own config**, even if it has one.

**Why our own config, unconditionally:** the target's own `eslint.config.mjs`/`tsconfig.json`/`.stylelintrc` reflects *their* accumulated exceptions and known-debt tier (see below) — running it would just mirror back whatever they already tolerate. The whole point of this stage is an independent, external standard.

**Where the rules came from.** Adapted from a real production TS/React monorepo's config (its `eslint.config.mjs`, shared ESLint config package, `.stylelintrc.json`, and `tsconfig.base.json`), then deliberately diverged in three ways:

1. **Every rule that repo has as `"warn"` is `"error"` here.** Their own code comments label these as "kept as warning to avoid major breakage" / "TODO: re-enable after migration" — i.e. a known-debt tier, not a genuine disagreement about severity. We don't inherit debt we didn't accrue.
2. **`eslint-plugin-sonarjs` is dropped entirely**, not demoted. Sonar is already a separate pipeline stage; enabling it in ESLint too would double-report the same findings under two different tool names.
3. **TypeScript-only.** No JS/JSX parsing branch, no Babel parser — `@typescript-eslint/parser` throughout, since every target codebase is TS/TSX-only.

Its private, workspace-only ESLint packages aren't published to npm and can't be installed standalone here, so the *rule content* was replicated using public equivalents (`@typescript-eslint`, `eslint-plugin-react`, `eslint-plugin-jsx-a11y`, `eslint-plugin-import`). Repo-layout-specific rules that don't generalize — SNAKE_CASE folder naming (`eslint-plugin-check-file`), the Lingui i18n rules, the `@`-alias-specific `no-restricted-imports` pattern — were dropped rather than ported.

**Security rules — verified against Sonar's live rule API before including anything**, not assumed:

| ESLint rule | Verdict | Why |
|---|---|---|
| `security/detect-unsafe-regex` | Dropped | Confirmed duplicate of Sonar `S5852`/`S8786` |
| `security/detect-eval-with-expression` | Dropped | Confirmed duplicate of Sonar `S1523`/`S3523` |
| `security/detect-pseudoRandomBytes` | Dropped | Turned out to target Node's `crypto.pseudoRandomBytes()`, not `Math.random()` as first assumed (corrected after checking the plugin's actual source) — irrelevant to frontend code either way |
| `security/detect-object-injection` | Dropped | No Sonar overlap, but too noisy/low-signal on typical TS code |
| `security/detect-child-process`, `detect-non-literal-fs-filename`, etc. | Dropped | Node-backend-only, meaningless on frontend code |
| **`security/detect-possible-timing-attacks`** | **Kept** | No Sonar equivalent found (checked directly against the live rules API). Note its actual matching logic is narrow — verified against the plugin's real source, not its README: only fires inside a bare `if (x === y)` (not `if (a && x === y)`, not `return x === y`) where one side's identifier name is an *exact* case-insensitive match to `token`/`secret`/`password`/`pass`/`hash`/`auth`/`api`/`apiKey` — not "contains." |
| **`no-unsanitized/method`, `no-unsanitized/property`** | **Kept** | Sonar's XSS-adjacent rules (`S5247`, `S8479`, `S6268`) only check that *existing* sanitization isn't disabled — none of them detect a raw `el.innerHTML = someVariable` in the first place. Genuinely new coverage. |

**TypeScript type-checking is intentionally separate from ESLint's type-aware rules.** `@typescript-eslint`'s `*-type-checked` rule sets need a fully resolved `tsconfig` + installed `node_modules` to work correctly — exactly the fragile, slow thing this stage already has to do once for `tsc` itself. Rather than wire the same fragility into ESLint too, ESLint runs in **non-type-aware mode** (fast, works even if dependency installation partially fails) and `tsc --noEmit` is the sole source of type-correctness findings.

**The static tsconfig** (`backend/config/tsconfig.static.json`) is used unconditionally — the target's own `tsconfig.json`, if present, is never read. Direct consequence: any codebase using import aliases (`@/components/...`) will show unresolved-module noise, since we have no `paths` mapping and don't guess at bundler-specific alias conventions. Accepted tradeoff, not a bug.

**Real `npm install` is required for type-checking** (unlike the dependency-audit stage's lockfile-only install) — `tsc` needs actual `.d.ts` files on disk to resolve imports; a lockfile alone isn't enough. Run with `--ignore-scripts` for the same untrusted-input reason as everywhere else. `skipLibCheck: true` is load-bearing here specifically: since script-free installs can't run some packages' full setup, a single broken third-party `.d.ts` shouldn't be able to blow up the whole run.

**Race condition found and fixed during testing:** the Dependencies stage and the Code Quality stage both run `npm` against the *same* extracted directory, and both are triggered concurrently by the frontend. Two `npm install`-family processes running at once in the same project directory can corrupt `package-lock.json`/`node_modules` — npm has no cross-process lock for that. Fixed with `backend/src/services/npmLock.js`, a simple per-directory promise-chain mutex that both `npmAudit.js` and `codeQuality.js` acquire before touching npm state. Verified by firing both stages at the same scan simultaneously and confirming clean results with no errors.

### 5. AI Explain — a custom tool-use agent, not the Claude Agent SDK

`backend/src/services/fastExplainer.js`. This went through the most iteration of any stage — worth understanding the path, not just the final shape, because each earlier version was abandoned for a real, tested reason.

**v1 — Claude Agent SDK** (`agentExplainer.js`, still in the repo, unused). Used `@anthropic-ai/claude-agent-sdk`'s `query()`, which spawns a bundled `claude` CLI subprocess with its own Read/Grep/Glob tools. Worked, but was a **single long sequential conversation** — one turn per file read, no parallelism within a run. On a real production-scale finding count this was visibly slow ("looks like no output" / turn-limit failures on large batches).

**v2 — deterministic batching, no agent.** Grouped findings by rule in plain Node (free, instant), fetched one representative code snippet per group via `fs.readFileSync` (also free), then sent fixed prompts to the plain Messages API in parallel batches. Fast, but explicitly **not what was asked for** — "I want to build an agent that will read the code and take decisions, instead of using claude code" — pre-fetching one snippet per group removes exactly the adaptive judgment (deciding what to read, searching for related usages) that makes an agent useful over a template.

**v3 — current: our own tool-use agent, no Agent SDK.** A plain loop against `@anthropic-ai/vertex-sdk`'s Messages API, with two tools implemented from scratch:
- `read_file` — real `fs.readFileSync`, path-traversal guarded (resolves and checks the result stays inside the extracted root)
- `search_code` — a real recursive regex search (skips `node_modules`/`.git`, capped results) — not shelling out to `grep`, since the search pattern comes from the model and untrusted input in a shell command is an injection risk
- `submit_explanations` — a custom tool the agent calls with its final structured answer

Findings are still grouped by rule in plain Node first (that's bookkeeping, not "reading code and deciding" — no reason to burn agent turns on what a `Map` does for free), but each group's *exploration* is genuinely adaptive: verified live, the agent read `package-lock.json` to get exact resolved transitive-dependency versions it was never given, and searched for who imports a flagged config file before writing its explanation.

**Batches run concurrently** (`CLAUDE_EXPLAIN_CONCURRENCY`, default 5) — something the single-session Agent SDK approach structurally couldn't do. This is the actual fix for "the AI was taking too long": not a faster model, but real parallelism across independent groups.

**A real bug found and fixed via live testing:** a batch that ran out of its turn budget before calling `submit_explanations` used to lose *all* of that batch's groups — silent, total loss of work already done. Fixed with a forced final-turn reminder ("submit your best answer now, even incomplete") injected on the last available turn, so a rushed batch still returns partial results instead of nothing.

**Structured output avoids a real org policy block.** A direct attempt to use the Messages API's `output_config.format` (server-enforced JSON schema) can fail on Vertex AI where an org policy restricts partner-model features (structured outputs among them). The `submit_explanations` custom-tool pattern sidesteps this entirely — it's an ordinary tool call, not the restricted API parameter, and was in fact how the Agent SDK's own internal `StructuredOutput` mechanism worked in v1 too (visible in its live log as `"Using StructuredOutput"`).

**Output is dual-audience, not just prose.** Per explicit request, each group carries both a human-readable explanation (`issue`/`why`/`fixSummary`) *and* a machine-applicable patch spec (`fixType`, exact verbatim `find`/`replace` text, `agentInstructions`) — so the JSON can be handed to another AI/tool to locate and apply the fix with no further investigation. `fixType` is one of `single_location` (one change fixes the whole group), `pattern_all_occurrences` (identical text transform at every occurrence), or `manual_per_occurrence` (no safe blind patch — explained instead). Verified live: `find` strings came back character-for-character exact matches to the real source, not paraphrases.

**Real-time progress, not a static "please wait."** Both this stage and the Code Quality stage stream Server-Sent Events (`frontend/src/api.js`'s `streamSSE()` helper, shared by both) instead of blocking on one long request — every line in the UI's live log corresponds to something that actually just happened (a file read, a search, a batch completing), never a simulated percentage.

---

## The UI

`frontend/src/App.jsx` + `components/`. Went through several rounds of feedback, each changing something structural, not cosmetic:

1. **Everything-stacked-on-one-page** → **click-to-view-one-stage-at-a-time.** All four (later five) report panels used to render top-to-bottom on a single page. Replaced with a two-part header: `Pipeline.jsx` (a small, non-interactive status strip — dots connected by lines, just shows where the run stands) sits above `Tabs.jsx` (the actual clickable navigation, one panel visible at a time). These are deliberately two separate components, not one — the first round tried making the pipeline status strip itself clickable, which didn't read as interactive (no hover state, connector lines visually signal "linear progress," not "pick one"); splitting status-display from navigation and giving the tabs their own affordance (segmented-control style, hover states, `cursor: pointer` — which the first pass genuinely forgot to set) fixed that.
2. **Upload vanishes after a scan starts** — `UploadPanel` only renders when there's no active scan; "Upload another codebase" resets state and brings it back.
3. **Auto-trigger.** AI Explain used to require a manual button click. Now `Promise.allSettled` across all four upstream stages triggers it automatically once they've all landed.
4. **Dark theme**, on request for "something better and best" after two lighter iterations didn't land — a full rewrite of `App.css`/`index.css` to a "security console" aesthetic: near-black background, layered card backgrounds instead of box-shadow-on-white for depth (shadows barely read on dark backgrounds), a violet accent. This touched nearly every hardcoded color in the stylesheet, so it was a full rewrite, not a patch.

---

## Security notes

- Every token lives only in `backend/.env` (gitignored) and is never sent to the browser.
- `SESSION_SECRET` is required — the backend refuses to start without it rather than falling back to a guessable key.
- **Sign-in is a placeholder, not authentication.** `POST /api/auth/login` accepts any email with no password (`backend/src/routes/auth.js`) and exists only until real SSO is wired in. Don't expose this app beyond localhost or a trusted network as-is.
- Uploaded zips are extracted with zip-slip and zip-bomb guards (`backend/src/services/zipExtract.js`).
- Every `npm install` this project runs against untrusted uploaded content uses `--ignore-scripts` (dependency audit, code-quality type-checking) — an uploaded `package.json`'s pre/postinstall hooks are arbitrary code execution otherwise.
- `search_code` in the AI Explain agent is a hand-written recursive regex matcher, not a shell-out to `grep` — the search pattern is model-controlled input, and passing that through a shell would be an injection risk.
- `read_file` in the same agent is path-traversal guarded: every path is resolved and checked to remain inside the extracted root before reading.

## Known limitations (accepted, not oversights)

- **Sonar hotspots endpoint** (`api/hotspots/search`) returns "Insufficient privileges" unless the token's account has been granted security-hotspot access on the project by a Sonar admin; without it, hotspots are simply absent from the report.
- **Sonar project cleanup**: the current design intentionally overwrites the configured project's live dashboard on every upload (see "Sonar project lifecycle" above) — a deliberate tradeoff after the isolated-project design proved undeletable.
- **Import aliases break type-checking**: our static tsconfig has no `paths` mapping, so alias-heavy codebases (`@/foo`) will show unresolved-module noise in the TypeScript findings.
- **`agentExplainer.js` is dead code**: kept in the repo as the v1 Agent-SDK-based implementation for reference, not routed to anything.

## Project structure

```
backend/
  config/
    eslint.config.mjs       # our fixed ESLint rules (see "Code Quality stage")
    stylelint.config.json   # our fixed Stylelint rules
    tsconfig.static.json    # our fixed tsconfig, always used regardless of the target's own
  src/
    routes/scans.js         # all /api/scans/* endpoints
    services/
      zipExtract.js          # zip-slip/zip-bomb-guarded extraction
      betterleaks.js          # secrets scan
      npmAudit.js              # dependency vulnerability scan
      npmLock.js               # per-directory npm mutex (shared by npmAudit + codeQuality)
      sonar.js                  # read-only Sonar results fetch (measures/issues/quality-gate)
      sonarScanner.js            # runs the real sonar-scanner against SONAR_PROJECT_KEY
      codeQuality.js              # ESLint + tsc + Stylelint, our fixed configs
      findings.js                  # flattens all four scan stages' findings for the explain agent
      fastExplainer.js              # the current, live custom tool-use AI explain agent
      agentExplainer.js             # v1, Agent-SDK-based - unused, kept for reference
frontend/
  src/
    App.jsx                 # pipeline orchestration, stage state, auto-trigger
    api.js                   # fetch wrappers + shared streamSSE() helper
    components/
      Pipeline.jsx            # small non-interactive status strip
      Tabs.jsx                  # the actual clickable stage navigation
      UploadPanel.jsx
      SecretsReport.jsx
      DependencyReport.jsx
      SonarReport.jsx
      CodeQualityReport.jsx
      ExplainReport.jsx
      SeverityBadge.jsx
```

## License

[MIT](LICENSE)
