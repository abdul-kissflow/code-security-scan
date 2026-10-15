// Standalone ESLint config for the Code Quality scan stage.
//
// This is NOT a copy of any target codebase's own ESLint config - it is our
// fixed house standard, applied the same way regardless of what (if
// anything) the uploaded codebase itself configures. Derived from
// an internal TS/React monorepo's shared ESLint config, with three deliberate
// differences:
//   1. every rule that was "warn" there is "error" here - no known-debt tier
//   2. eslint-plugin-sonarjs is dropped entirely - SonarQube is already a
//      separate pipeline stage; duplicating its rules here would just
//      double-report the same findings under two tool names
//   3. TS/TSX get the TypeScript-aware block below; plain JS/JSX (Kissflow
//      custom-UI starter apps) get their own block at the bottom
//
// Type-aware rules (@typescript-eslint's *-type-checked sets, no-floating-
// promises, etc.) are intentionally NOT enabled here. They require a fully
// resolved tsconfig + installed node_modules, which is exactly what the
// separate `tsc --noEmit` check (services/codeQuality.js) already does more
// correctly and completely. Keeping ESLint non-type-aware means it never
// needs the target project's dependencies installed to run, and never
// produces the misleading half-resolved-types noise that a partial install
// would cause.

import js from "@eslint/js";
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import reactPlugin from "eslint-plugin-react";
import reactHooksPlugin from "eslint-plugin-react-hooks";
import jsxA11yPlugin from "eslint-plugin-jsx-a11y";
import importPlugin from "eslint-plugin-import";
import securityPlugin from "eslint-plugin-security";
import noUnsanitizedPlugin from "eslint-plugin-no-unsanitized";
import globals from "globals";

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/.next/**",
      "**/coverage/**",
      "**/*.d.ts",
    ],
  },

  {
    files: ["**/*.ts", "**/*.tsx"],
    plugins: {
      "@typescript-eslint": tsPlugin,
      react: reactPlugin,
      "react-hooks": reactHooksPlugin,
      "jsx-a11y": jsxA11yPlugin,
      import: importPlugin,
      security: securityPlugin,
      "no-unsanitized": noUnsanitizedPlugin,
    },
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
        ecmaFeatures: { jsx: true },
        // Deliberately no `project` - see file header. Keeps this rule set
        // fast and independent of whether the target's deps installed cleanly.
      },
      globals: { ...globals.browser, ...globals.node },
    },
    settings: {
      react: { version: "detect" },
      "import/resolver": {
        node: {
          extensions: [".js", ".jsx", ".ts", ".tsx", ".json", ".css"],
        },
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      ...reactPlugin.configs.flat.recommended.rules,
      ...reactHooksPlugin.configs["recommended-latest"].rules,
      ...jsxA11yPlugin.configs.recommended.rules,
      ...tsPlugin.configs.recommended.rules,
      ...importPlugin.flatConfigs.recommended.rules,

      // --- General correctness (kf baseline, promoted to error) ---
      eqeqeq: "error",
      "no-console": ["error", { allow: ["warn", "error", "info"] }],
      "no-debugger": "error",
      "no-alert": "error",
      "array-callback-return": "error",
      "func-names": ["error", "always"],
      "no-trailing-spaces": ["error", { ignoreComments: true, skipBlankLines: true }],
      "max-len": ["error", { code: 120, ignoreComments: true }],
      "max-depth": ["error", 5],
      "max-params": ["error", 6],
      "max-nested-callbacks": ["error", 4],

      "no-restricted-properties": [
        "error",
        {
          object: "Math",
          property: "random",
          message: "Do not use Math.random(). Use a UUID library or crypto API instead.",
        },
      ],

      // --- React ---
      "react/prop-types": "off", // TypeScript props serve this purpose
      "react/react-in-jsx-scope": "off", // react-jsx runtime
      "react/display-name": "off",
      "react/forbid-prop-types": "off", // n/a without prop-types
      "react-hooks/exhaustive-deps": "error",
      "react-hooks/rules-of-hooks": "error",

      //* a11y - kf keeps these as warn "due to major breakage"; we don't
      //* carry known debt forward, so these are errors here.
      "jsx-a11y/click-events-have-key-events": "error",
      "jsx-a11y/no-static-element-interactions": "error",
      "jsx-a11y/label-has-associated-control": "error",
      "jsx-a11y/no-noninteractive-element-interactions": "error",
      "jsx-a11y/no-noninteractive-tabindex": "error",
      "jsx-a11y/no-autofocus": "error",
      "jsx-a11y/tabindex-no-positive": "error",
      "jsx-a11y/media-has-caption": "error",
      "jsx-a11y/interactive-supports-focus": "error",
      "jsx-a11y/mouse-events-have-key-events": "error",

      // --- Imports ---
      "import/no-cycle": ["error", { maxDepth: 10, ignoreExternal: true }],
      "import/no-duplicates": "error",
      "import/no-mutable-exports": "error",
      "import/no-named-as-default": "error",
      "import/no-named-as-default-member": "error",
      "import/newline-after-import": ["error", { count: 1 }],
      "import/no-unresolved": "off", // resolver can't see an uninstalled target's deps
      "import/order": [
        "error",
        {
          groups: ["builtin", "external", "internal", "sibling", "index", "type", "object"],
          "newlines-between": "always",
          alphabetize: { order: "asc", caseInsensitive: true },
        },
      ],

      // --- TypeScript ---
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
      "@typescript-eslint/array-type": ["error", { default: "generic", readonly: "generic" }],
      "@typescript-eslint/consistent-indexed-object-style": ["error", "record"],
      "@typescript-eslint/consistent-type-definitions": ["error", "interface"],
      "@typescript-eslint/ban-ts-comment": [
        "error",
        { "ts-expect-error": "allow-with-description", "ts-ignore": "allow-with-description" },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { args: "after-used", argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],

      // --- Security ---
      // Only the two rules confirmed to NOT duplicate a SonarQube rule
      // (verified against the live Sonar rules API - see project docs).
      // Everything else in eslint-plugin-security either duplicates a
      // confirmed Sonar rule (detect-unsafe-regex -> S5852/S8786,
      // detect-eval-with-expression -> S1523/S3523) or is Node-backend-only
      // noise on a frontend codebase (detect-child-process,
      // detect-non-literal-fs-filename, detect-buffer-noassert,
      // detect-new-buffer, detect-no-csrf-before-method-override,
      // detect-pseudoRandomBytes) or too noisy to be useful
      // (detect-object-injection).
      "security/detect-possible-timing-attacks": "error",
      "no-unsanitized/method": "error",
      "no-unsanitized/property": "error",
    },
  },

  // Plain JS/JSX - ported from an internal AI-plugin repo's scan-engine/config/eslint.config.mjs,
  // whose target (Kissflow custom-UI starter apps) is JS/JSX only. Same house rules as the TS block
  // above minus everything that needs TypeScript, and with that project's deliberate removals:
  //   - no TS parser/plugin/rules (espree parses JS + JSX natively); plain no-unused-vars instead
  //   - class-component-only React rules off (starter apps are functional components only)
  //   - no Math.random() ban - the AI security review judges its *use* (token/nonce/id...) instead
  //   - no import/order (pure aesthetics), and import/named|namespace|default|export off for the
  //     same reason import/no-unresolved already is: they need the target's deps installed
  {
    files: ["**/*.js", "**/*.jsx"],
    plugins: {
      react: reactPlugin,
      "react-hooks": reactHooksPlugin,
      "jsx-a11y": jsxA11yPlugin,
      import: importPlugin,
      security: securityPlugin,
      "no-unsanitized": noUnsanitizedPlugin,
    },
    languageOptions: {
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
        ecmaFeatures: { jsx: true },
      },
      globals: { ...globals.browser, ...globals.node },
    },
    settings: {
      react: { version: "detect" },
      "import/resolver": {
        node: {
          extensions: [".js", ".jsx", ".json", ".css"],
        },
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      ...reactPlugin.configs.flat.recommended.rules,
      ...reactHooksPlugin.configs["recommended-latest"].rules,
      ...jsxA11yPlugin.configs.recommended.rules,
      ...importPlugin.flatConfigs.recommended.rules,

      // --- General correctness ---
      eqeqeq: "error",
      "no-console": ["error", { allow: ["warn", "error", "info"] }],
      "no-debugger": "error",
      "no-alert": "error", // native alert/confirm/prompt misbehave inside Kissflow's iframe
      "array-callback-return": "error",
      "func-names": ["error", "always"],
      "no-trailing-spaces": ["error", { ignoreComments: true, skipBlankLines: true }],
      "max-len": ["error", { code: 120, ignoreComments: true }],
      "max-depth": ["error", 5],
      "max-params": ["error", 6],
      "max-nested-callbacks": ["error", 4],
      "no-unused-vars": [
        "error",
        { args: "after-used", argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],

      // --- React ---
      "react/prop-types": "off", // no type system to define props against
      "react/react-in-jsx-scope": "off", // react-jsx runtime
      "react/display-name": "off",
      "react/forbid-prop-types": "off",
      "react/no-string-refs": "off", // class-component APIs - functional components only
      "react/no-is-mounted": "off",
      "react/no-find-dom-node": "off",
      "react/no-direct-mutation-state": "off",
      "react-hooks/exhaustive-deps": "error",
      "react-hooks/rules-of-hooks": "error",

      // --- a11y (errors, not known-debt warnings) ---
      "jsx-a11y/click-events-have-key-events": "error",
      "jsx-a11y/no-static-element-interactions": "error",
      "jsx-a11y/label-has-associated-control": "error",
      "jsx-a11y/no-noninteractive-element-interactions": "error",
      "jsx-a11y/no-noninteractive-tabindex": "error",
      "jsx-a11y/no-autofocus": "error",
      "jsx-a11y/tabindex-no-positive": "error",
      "jsx-a11y/media-has-caption": "error",
      "jsx-a11y/interactive-supports-focus": "error",
      "jsx-a11y/mouse-events-have-key-events": "error",

      // --- Imports ---
      "import/no-cycle": ["error", { maxDepth: 10, ignoreExternal: true }],
      "import/no-duplicates": "error",
      "import/no-mutable-exports": "error",
      "import/no-named-as-default": "error",
      "import/no-named-as-default-member": "error",
      "import/newline-after-import": ["error", { count: 1 }],
      "import/no-unresolved": "off",
      "import/named": "off",
      "import/namespace": "off",
      "import/default": "off",
      "import/export": "off",

      // --- Security (same two non-Sonar-duplicating rules as the TS block) ---
      "security/detect-possible-timing-attacks": "error",
      "no-unsanitized/method": "error",
      "no-unsanitized/property": "error",
    },
  },
];
