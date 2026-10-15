Every finding below carries an inherent confidence tier — respect it, don't collapse the distinction:
- PROVABLE findings are deterministic from source/React/HTTP semantics alone — no runtime test needed. Use evidenceStatus "confirmed".
- HYBRID findings are strong, real static candidates whose actual cost/impact can only be confirmed by a profiler capture, network trace, or measuring real data volume. Use evidenceStatus "insufficient-evidence" and name the exact profiler/trace evidence needed in requiredEvidence — never assert these as flatly confirmed.
- SPECULATIVE findings depend on real traffic, scale, or usage patterns a static pass cannot see. Report these sparingly, phrased as a question, evidenceStatus "insufficient-evidence" or "review-required" (use review-required when it's really a product/ops decision like "is this polling interval acceptable given real server load"), generally at MEDIUM/LOW severity unless the code shape makes the risk obvious regardless of scale.

Each bullet below lists what to look for AND the false-positive (FP) discriminator that separates a real finding from a superficially-similar non-issue — check the discriminator before flagging; getting this wrong is the single biggest way this review loses credibility. If something is only theoretically a problem but has no realistic impact given this codebase's actual scale and usage, do not report it. Skip a dimension entirely if there's nothing meaningful in it — do not pad findings to fill every dimension.

Merge related findings before submitting: if multiple locations share the same root cause, report them as ONE finding with multiple occurrences and a summary covering the root cause, not several near-duplicates.

## rendering_performance (Rendering Performance)
- Component TYPE defined inside another component's render body. [PROVABLE] New type identity every parent render forces a full unmount/remount of the subtree. FP: a render-helper called as a function ({renderRow(item)}, not <RenderRow/>); module-scope HOC factories.
- Unstable literal (object/array/arrow function) prop passed into a React.memo'd child. [HYBRID] Defeats the memo's shallow-equality check. FP: child isn't actually memoized; the prop lands on a host DOM element; the component only ever renders once.
- Context value built as a fresh literal every provider render. [HYBRID] Every consumer re-renders on every provider render regardless of which field it reads. FP: provider is provably render-once.
- One context bundling fields with unrelated change frequencies forcing every consumer to re-render on any field's change — split by cadence.
- Expensive pure computation in the render body (.sort()/.filter().map() chains, JSON.parse, new Intl.*Format() construction) outside useMemo or a handler. [HYBRID] FP: bounded input (roughly under 50 items), or not on an interaction path.
- Array index used as key on a reorderable/filterable list. [HYBRID] FP: a static, append-only, never-reordered list with stateless rows.
- Unvirtualized list rendering unbounded data via plain .map() with no virtualizer. [HYBRID] Confirm via realistic DOM node count, ideally post-interaction. FP: API-bounded length.
- Broken memoization: useMemo/useCallback/memo whose own dependency is itself an inline literal or an unmemoized context value, so the memo never actually hits.
- Derived state stored in useState whose only writers are its initializer and a useEffect recomputing it from props/state. [HYBRID] Should be computed inline or via useMemo instead.
- Effect chains where setState in one effect feeds another effect's dependencies, cascading renders with visible intermediate states.

## api_call_patterns (API Call Patterns & Request Topology)
- Waterfall via chained dependent queries where one query's enabled/key transitively depends on another query's data. [HYBRID] Flag chains of depth 4+ or with a large estimated cost. FP: enabled gated on user intent, not on another query's data.
- Client-side N+1: a row/item component calls a data hook per item instead of the parent batching. [HYBRID] FP: virtualized infinite scroll where each row's request is user-paced.
- Sequential independent awaits that could run via Promise.all. [HYBRID] FP: a genuine dependency, or deliberate serialization for rate limiting.
- Missing debounce/throttle on a high-frequency trigger (keystroke/scroll/drag) that fires a network call directly with no stale-response guard. [SPECULATIVE] Note when this compounds with a missing latest-wins guard — that combination is a correctness bug.
- Over-fetching: a large response payload where most fields are never read anywhere in the codebase. [SPECULATIVE]
- Duplicate fetches: two or more call sites hitting the same logical endpoint under different cache keys.
- Polling interval or setInterval-based poll with no pause when the tab is hidden or the component unmounted. [SPECULATIVE]
- Unbounded list query with no page-size bound and no pagination. [HYBRID] Fine with today's seed data, an OOM/multi-MB-parse risk at scale.

## caching_correctness (Caching Correctness)
This is the highest-severity category in this domain — a wrong cache key or missing scope is a data-leak bug, not just a performance issue.
- Cache key missing a discriminating input (tenant/user/locale/role/permission scope). [HYBRID, but treat as CRITICAL/HIGH when found] A fetcher that closes over a free variable absent from the query key means switching context serves the PREVIOUS context's cached data under the same key — a cross-tenant/cross-user data leak.
- Mutation with missing or incomplete cache invalidation. [HYBRID] No invalidation on success leaves stale data indefinitely; harder case — invalidation exists but misses a related resource.
- Over-broad invalidation: a filterless cache-wide invalidate from one mutation refetches everything app-wide (a refetch storm). FP: a deliberate post-logout/tenant-switch teardown.
- Stale-while-revalidate misuse for reference/config data left at default freshness causing a refetch on every mount/focus. [SPECULATIVE] The inverse is worse to flag wrongly: a deliberately-live near-zero staleTime on a poller or payment-confirmation poll is correct, not a bug.
- Unbounded in-memory/module-scope cache (a bare Map() or object) with no size cap, TTL, or logout-clear — a memory-exhaustion vector if it's keyed on user input.
- Persisted client state with no schema version or migration path. [HYBRID] Escalate sharply if the persisted shape visibly changed without a version bump.
- Server state duplicated into a hand-rolled client store reimplementing dedup/staleness/GC/cancellation/retry worse than an already-present query library would. Check this first — it's often the root cause behind several other caching findings at once.
- Optimistic update with no rollback path: an update handler that writes optimistically but is missing a cancel-in-flight guard, a snapshot, an error restore, or a settle-time reconciliation. [HYBRID] The failure mode is silent: the UI shows success, the mutation actually fails server-side, and the next background refetch quietly reverts the UI with no error ever shown.

## request_lifecycle_resilience (Request Lifecycle & Resilience)
- Fetch inside a useEffect with no AbortController/ignore-flag, whose continuation calls setState. [PROVABLE] Rapid input changes fire multiple requests and whichever resolves LAST wins the state update — a correctness bug, not just wasted bandwidth. Common near-miss: an AbortController is created and .abort()'d in cleanup, but its .signal is never actually passed into the fetch call.
- An async event handler (not an effect) with the same race condition: search-as-you-type, save, or filter handler fires async work and writes to state with no sequence/generation guard.
- fetch() response never checked for res.ok before calling .json(). [PROVABLE] fetch() does not reject on 4xx/5xx; an unconditional .json() call on a 500 HTML error page throws an unrelated SyntaxError instead of surfacing the real failure.
- Abort or timeout errors treated as genuine user-facing failures: a .catch that doesn't check error.name === 'AbortError' before showing an error to the user.
- Retry logic applied to non-idempotent mutations (POST/PATCH) with no idempotency key. [HYBRID] Risks a duplicate side effect on ordinary flakiness.
- Retry with no cap and/or no jitter.
- A failed mutation whose error is silently swallowed with no queued-retry state and no user-visible error — the user's work vanishes with no signal it failed.

## state_management_performance (State Management Performance Implications)
- A global store slice with exactly one consumer, or all consumers confined to one small subtree. [HYBRID] Unnecessary update blast radius.
- A store selector that allocates a new object/array with no equality function under a reference-equality subscription model. [HYBRID] FP: paired with a shallow-equality helper at the call site.
- The same entity duplicated across multiple store locations with independent update paths and no single source of truth. [SPECULATIVE]
- View-identifying state (search query, active tab, filter, sort, page, selected id) kept only in component state instead of the URL — breaks deep links, refresh, back button, sharing. [SPECULATIVE] Require all three: shareable, non-sensitive, affects what data gets loaded.
- A large form re-rendering fully on every keystroke because one useState object is spread-updated on every field's onChange. [SPECULATIVE] Gate on field count.

## bundle_build_performance (Bundle & Build Performance)
This category needs the build artifact (a stats.json, source maps, or a package.json/lockfile inspection) as well as source — say so explicitly (evidenceStatus insufficient-evidence, requiredEvidence naming the exact artifact) whenever you can't confirm from source alone.
- First-party barrel-file (index.ts re-export) imports that appear to pull in a large module graph for one named import.
- `sideEffects: false` declared in package.json on a module that has real side effects (an imported .css file, top-level prototype patching, analytics auto-init) — the bundler can silently drop that import, and components render unstyled with no build error.
- Whole-library default import where a tree-shakeable form exists, the canonical example being `import _ from 'lodash'` instead of named imports from `lodash-es`. [PROVABLE for well-known offenders like this]
- A heavy, rarely-used library (rich-text editor, chart library, map SDK, PDF viewer) imported statically at the top of a file instead of behind a dynamic import(), when it's actually gated behind a flag/modal/rare route. [HYBRID]

