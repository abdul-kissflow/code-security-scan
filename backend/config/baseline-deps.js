// Ported from an internal AI-plugin repo's scan-engine/config/baseline-deps.mjs. Applied ONLY when the
// upload is detected as a Kissflow custom-UI starter app (see src/services/projectProfile.js) -
// for any other codebase these are ordinary dependencies that must be audited and counted.
//
// CANONICAL COPY of the custom-UI scaffold's own dependency names - re-sync this list whenever
// starter/package.json's `dependencies`/`devDependencies` change, the same "edit here, not in an
// app" discipline scripts/theme-check.mjs and scripts/shell-check.mjs already follow for their own
// canonical copies.
//
// WHY THIS EXISTS. npm audit (services/npmAudit.mjs) runs against a generated app's FULL resolved
// tree, which is overwhelmingly the scaffold's own baseline deps (react, vite, @radix-ui/*,
// recharts, ...) - none of which the app-building agents chose or can fix. Flagging a CVE in the
// scaffold on every single generated app's health score is the identical false-attribution bug
// services/reachability.mjs exists to fix for lint/Sonar, just for dependencies instead of source
// files: scanning framework surface as if it were an app-authored decision. Only packages the
// agents actually ADDED beyond this baseline (e.g. a page needing a chart library the scaffold
// doesn't ship) should count against the score - and npm audit already covers those correctly,
// since they're audited the same as everything else; only the OUTPUT is filtered, not the scan.
//
// CAVEAT: this is starter/package.json in THIS repo, used for local dev of the plugin itself.
// Real generated apps are scaffolded by the external `@kissflow/create-app` package
// (`npx @kissflow/create-app --target app`, see commands/build-app.md Step 0), which is meant to
// track this same baseline but isn't guaranteed byte-identical - if the two drift, a genuinely
// baseline package could show up here as "extra" (audited, not excluded) rather than the reverse,
// which is the safer direction for a failure to lean (over-checking, not under-checking).
//
// LIMITATION, not fixed: this filters by package NAME only, not by dependency chain. A vulnerable
// package that's a TRANSITIVE dependency ONLY of a baseline package (not of anything the agent
// added) will still show up unfiltered, because its own name isn't in this list - attributing
// findings through the full `via` chain would catch that, and hasn't been built.

export const BASELINE_DEP_NAMES = new Set([
  // dependencies
  "@dnd-kit/core",
  "@dnd-kit/sortable",
  "@hookform/resolvers",
  "@kissflow/app-ui",
  "@kissflow/lowcode-client-sdk",
  "@radix-ui/react-accordion",
  "@radix-ui/react-avatar",
  "@radix-ui/react-checkbox",
  "@radix-ui/react-dialog",
  "@radix-ui/react-dropdown-menu",
  "@radix-ui/react-label",
  "@radix-ui/react-popover",
  "@radix-ui/react-select",
  "@radix-ui/react-separator",
  "@radix-ui/react-slot",
  "@radix-ui/react-switch",
  "@radix-ui/react-tabs",
  "@radix-ui/react-tooltip",
  "@react-three/drei",
  "@react-three/fiber",
  "@tanstack/react-query",
  "@tanstack/react-table",
  "@tanstack/react-virtual",
  "@xyflow/react",
  "class-variance-authority",
  "clsx",
  "cmdk",
  "date-fns",
  "framer-motion",
  "frappe-gantt",
  "leaflet",
  "lucide-react",
  "next-themes",
  "papaparse",
  "react",
  "react-big-calendar",
  "react-day-picker",
  "react-dom",
  "react-dropzone",
  "react-error-boundary",
  "react-hook-form",
  "react-leaflet",
  "react-router-dom",
  "recharts",
  "sonner",
  "tailwind-merge",
  "tailwindcss",
  "three",
  "zod",
  // devDependencies
  "@tailwindcss/vite",
  "@vitejs/plugin-react",
  "archiver",
  "tw-animate-css",
  "vite",
  "vite-plugin-pages",
]);
