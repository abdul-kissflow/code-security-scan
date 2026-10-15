// Customer-facing display names for the internal source/category identifiers
// that flow through from the backend (scan "tool" values, finding-group
// "sourceTools"). Never render those raw identifiers directly in the UI.
export const SOURCE_LABEL = {
  betterleaks: "Secrets",
  "npm-audit": "Dependencies",
  sonarqube: "Code Analysis",
  eslint: "Code Standards",
  typescript: "Type Safety",
  stylelint: "Styling",
  suppression: "Suppressed Checks",
  "ai-code-review": "AI Code Review",
};

export function sourceLabel(id) {
  return SOURCE_LABEL[id] || id;
}
