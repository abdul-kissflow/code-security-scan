Review all applicable dimensions below. If something is only theoretically a problem but has no realistic impact given this codebase's actual scale and usage, do not report it. Skip a dimension entirely if there's nothing meaningful in it — do not pad findings to fill every dimension. Be strict and accurate: every finding must point at real, specific locations with a concrete divergence or violation — never a vague "consider improving structure."

Split every finding into one of two kinds and say which by how you phrase "issue"/"impact": an ASSERTION (unambiguously true once a rule is declared — e.g. "layer X imports layer Y, inverting the intended dependency direction") stated with full confidence via evidenceStatus "confirmed"; or a JUDGMENT CALL (contextual, could be intentional) phrased as a specific question with the competing evidence cited, using evidenceStatus "review-required" and requiredEvidence naming exactly what a human needs to confirm. Never state a judgment call with false confidence.

Merge related findings before submitting: if one root cause trips several separate checks, report it once with all evidence attached as multiple occurrences, not as several near-duplicate findings.

Prioritize new/changed-looking code and actively-edited-looking files (there is no git history available to you - judge from the code itself) over stable pre-existing debt — the same structural issue matters far more in a file edited weekly than one nobody touches. Weight findings up when they sit in shared/widely-imported code (a design-system component, a core hook, a "lib"/"shared" module) since the blast radius multiplies across every consumer. Cap yourself to genuinely well-evidenced findings — a handful of high-confidence findings beats a long list of marginal ones; volume erodes trust faster than a missed finding does.

## architectural_layering (Architectural Layering & Boundary Violations)
- UI/presentational files (components/, pages/, views/) importing directly from data-access modules (API clients, query builders, raw fetch/axios) or domain/business-logic modules, bypassing any declared service/hook layer.
- A "shared"/"core"/"lib" directory that itself imports from feature-specific directories — inverts the intended dependency direction; shared code should have zero feature-layer deps.
- In a feature-sliced or domain-folder repo (features/, modules/, domains/), one feature reaching into another feature's internals instead of its declared public entry point (index.ts) — e.g. features/orders/* importing directly from features/checkout/utils/*.
- Deep relative imports that cross a feature/module boundary (../../../other-feature/internal/x) — an undeclared dependency that breaks silently on a folder reorg. Deep relative imports *within* one feature are fine and not a finding.
- A client-only module (browser globals, window) transitively reachable from server-only code, or vice versa — check especially for env vars/secrets flowing from server config into client-bundled code via a shared types/utils file.
- In a monorepo/workspace, deep imports into another package's internal files instead of its published entry point.

## coupling_cohesion (Circular, Hidden & Cross-Feature Coupling)
- Runtime import cycles (A -> B -> C -> A) that are not type-only — trace import chains, especially through barrel files and store/slice indices.
- A module with unusually high fan-in (many unrelated features import it) that is *not* a declared architectural hub (router config, DI/composition root, design-system index) — judge by role, not raw import count; every change to it risks unrelated breakage.
- Barrel files used as an internal convenience within one app/feature rather than a genuine package public API — makes it impossible to tell what a consumer actually depends on. Public-API barrels are fine; intra-app grab-bag barrels are not.
- Two unrelated features sharing mutable state through a side channel other than the declared state-management solution — e.g. both reading/writing the same localStorage key or a global event bus instead of an explicit shared store/context.

## inconsistent_patterns (Inconsistent Cross-Cutting Patterns — "N clean ways to do the same thing")
Each instance below is individually unremarkable to a linter; the finding is the divergence itself, so you must cite at least two concrete locations solving the same kind of problem differently.
- Data fetching implemented via more than one convention with no documented rationale — raw fetch/axios inline in some places, a custom hook in others, a library (React Query/SWR) in a third, for structurally similar problems.
- Client state managed by more than one paradigm with no ownership rule — a store library in some features, Context in others, component-local state in a third, for similarly-shaped problems.
- Error handling that differs by feature: inline error UI here, silently swallowed there, thrown and caught by a top-level boundary elsewhere — with no shared error-handling utility/convention.
- Form handling split across libraries/patterns for similarly-shaped forms with no migration note.
- Loading/pending-state UI conventions that differ across features for structurally similar data-fetching scenarios.
- API response shapes handled inconsistently — some places normalize through a shared adapter/mapper, others consume raw backend shapes directly in components.
- Styling approach mixed without a documented boundary across equivalent UI needs.

## god_components_hooks (God Components & God Hooks — judge by responsibility, not size)
- A component/hook that owns multiple independently-changeable responsibilities — e.g. one component that simultaneously fetches/owns data, implements business rules, manages complex local state, and renders several visually distinct sections. Name each responsibility with its line range; don't rely on line count or complexity score.
- A hook whose name implies one concern but whose body also bundles unrelated side effects (analytics, routing, feature-flag checks, error toasts) that consumers can't opt out of.
- A hook/component that has become a dumping ground: every new cross-cutting need lands there because it's already imported everywhere.
- Distinguish deliberate composition roots (top-level app shell, provider stack, router config) — expected to be broad, not a finding — from centrality that grew organically in a component that was never meant to be architecture.

## prop_drilling_context (Prop Drilling vs. Context Misuse)
- The same prop passed unmodified through 3+ intermediate components that don't use it, in 2+ separate places in the tree, when a Context/Provider for that exact value already exists elsewhere — the fix is usually "reuse the existing context," not "thread it further."
- A new Context created for a single 2-level prop pass where a plain prop would be simpler and more explicit (evidenceStatus "review-required" — this is a judgment call).
- One Context value bundling several independently-changing pieces of state so a component only interested in one field re-renders on every unrelated update — should be split into narrower contexts.
- A Provider whose consumer count has shrunk to one or zero — check whether it's still justified versus a plain prop now.

## api_design_smells (Component & Hook API Design Smells)
- A props type spanning multiple unrelated configuration axes where most call sites only ever use a handful of the possible combinations.
- Boolean prop combinations that are only valid in certain pairings, with no type-level or runtime guard.
- Custom hooks that return inconsistent shapes across similar hooks in the repo — some tuples, others objects — with no naming/location convention signaling which to expect.
- A hook/component name that promises narrow behavior but whose actual side effects are broader — a naming-to-contract mismatch.
- Optional props that are silently required in practice (component misbehaves or crashes if omitted).

## domain_logic_in_view (Domain Logic Leaking into the View Layer)
- Pricing/tax/discount or other business arithmetic computed inline in a component's render logic or JSX rather than in a domain/service module.
- Eligibility/authorization/permission checks as ad hoc conditionals in components instead of a shared policy function.
- Workflow/state-machine transitions scattered across multiple components' conditionals instead of one named state machine/reducer.
- Validation rules duplicated between a component's inline checks and a schema library already used elsewhere.
- Currency/date/locale formatting or unit conversion hand-rolled in a component when the repo already has a shared formatter or uses Intl elsewhere.

## over_under_abstraction (Over-Abstraction & Under-Abstraction)
- A shared function/component taking a boolean or string-literal-union "mode" param used only to branch internal behavior, especially if a recent diff added *another* such flag to an already-branching shared function — call sites have diverged and the fix is often to un-share, not add another flag.
- Two or three near-identical components/hooks/utilities, clearly copy-pasted and now diverging, living in different feature folders with different owners.
- A hand-rolled reimplementation of something the platform, an installed dependency, or the repo's own utils already provides.
- A generic-sounding shared abstraction with only one real consumer, or where every consumer must pass overrides to make it fit.

## dead_architecture (Dead Architectural Patterns & Orphaned Structures)
- Files/modules unreachable from any entry point that weren't deleted — distinguish real orphans from framework-convention entry points a static import graph can't see (file-system routes, tests).
- A state slice/store/reducer or Context provider still wired into the app's provider tree with zero remaining consumers.
- An adapter/wrapper layer introduced to support swapping an implementation where only one implementation has ever existed.
- Commented-out blocks, old implementations kept "just in case" beside their replacement, or parallel files coexisting with the active version.

## design_system_drift (Design-System / Shared-Component Drift)
- Local components that duplicate the kit's (`@/components/kit/*`, `@/components/ui/*`) purpose and most of its props but were reimplemented from scratch rather than wrapping it — forks often diverge on accessibility (focus handling, keyboard support) in easy-to-miss ways.
- A shared component overridden with local styles/className at an unusually high fraction of its usages, especially when many overrides target the same property — usually means the shared component is missing a variant.
- Raw HTML elements used directly in many places despite an equivalent kit/shadcn primitive existing.
- Multiple icon systems, date-pickers, or modal/dialog implementations coexisting for the same purpose with no documented migration.

## test_coupling (Test-to-Code Coupling & Refactor Risk)
- Tests asserting on internal implementation details rather than observable behavior — such tests fail on safe refactors and pass on real regressions.
- The same test-setup/mocking boilerplate duplicated across many test files with no shared fixture/utility.
- Snapshot tests over large, frequently-changing UI trees where the snapshot is effectively rubber-stamped every diff.
- A module that can't be unit-tested without extensive mocking of unrelated systems because business logic is entangled with framework/IO concerns.

