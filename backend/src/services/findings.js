import { classifySecret, classifyDependency, classifySonarIssue, classifyCodeQuality } from "./pillarClassify.js";

/**
 * Flattens every tool's findings for a scan into one compact array, each
 * tagged with the same pillar (security/reliability/maintainability) the
 * health score uses - so the AI explain stage's groups can be filtered by
 * pillar too, consistently with the score above them.
 */
export function flattenFindings(scan) {
  const items = [];

  const secrets = scan.results.secrets;
  if (secrets?.findings) {
    for (const f of secrets.findings) {
      items.push({
        tool: "betterleaks",
        severity: f.severity,
        rule: f.rule,
        file: f.file,
        line: f.line,
        message: f.description,
        ...classifySecret(),
      });
    }
  }

  const deps = scan.results.dependencies;
  if (deps?.projects) {
    for (const proj of deps.projects) {
      if (!proj.ok) continue;
      for (const v of proj.vulnerabilities) {
        items.push({
          tool: "npm-audit",
          severity: v.severity,
          rule: v.package,
          file: proj.dir === "." ? "package.json" : `${proj.dir}/package.json`,
          line: null,
          message: v.via.find((e) => e.title)?.title || `Vulnerable dependency: ${v.package}`,
          ...classifyDependency(v.severity),
        });
      }
    }
  }

  const sonar = scan.results.sonar;
  if (sonar?.issues) {
    for (const i of sonar.issues) {
      items.push({
        tool: "sonarqube",
        severity: i.severity,
        rule: i.rule,
        file: (i.component || "").split(":").slice(1).join(":") || i.component,
        line: i.line,
        message: i.message,
        ...classifySonarIssue(i.type, i.severity),
      });
    }
  }

  const codeQuality = scan.results.codeQuality;
  if (codeQuality?.findings) {
    for (const f of codeQuality.findings) {
      items.push({
        tool: f.tool, // "eslint" | "typescript" | "stylelint"
        severity: f.severity,
        rule: f.rule,
        file: f.file,
        line: f.line,
        message: f.message,
        ...classifyCodeQuality(f.tool, f.severity),
      });
    }
  }

  return items;
}
