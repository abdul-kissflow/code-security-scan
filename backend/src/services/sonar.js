const MEASURE_KEYS = [
  "bugs",
  "vulnerabilities",
  "code_smells",
  "security_hotspots",
  "coverage",
  "duplicated_lines_density",
  "ncloc",
  "alert_status",
];

function authHeader() {
  const token = process.env.SONAR_TOKEN;
  if (!token) {
    throw Object.assign(new Error("SONAR_TOKEN is not set on the server (.env)"), { status: 500 });
  }
  // SonarQube token auth: token as HTTP Basic username, empty password.
  return "Basic " + Buffer.from(`${token}:`).toString("base64");
}

async function sonarGet(pathAndQuery) {
  const baseUrl = process.env.SONAR_URL;
  if (!baseUrl) {
    throw Object.assign(new Error("SONAR_URL is not set on the server (.env)"), { status: 500 });
  }

  const res = await fetch(`${baseUrl}${pathAndQuery}`, {
    headers: { Authorization: authHeader() },
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body?.errors?.map((e) => e.msg).join("; ") || res.statusText;
    return { ok: false, status: res.status, error: msg };
  }
  return { ok: true, data: body };
}

const ISSUES_PAGE_SIZE = 500; // Sonar's hard max for issues/search

/**
 * Fetches every issue (any type: bug/vulnerability/code smell, any
 * severity) for the project, paginating through the full result set.
 */
async function fetchAllIssues(projectKey) {
  const issues = [];
  let page = 1;
  let total = Infinity;

  while (issues.length < total && page <= 20) {
    // eslint-disable-next-line no-await-in-loop
    const result = await sonarGet(
      `/api/issues/search?componentKeys=${encodeURIComponent(projectKey)}&statuses=OPEN,CONFIRMED,REOPENED&ps=${ISSUES_PAGE_SIZE}&p=${page}`
    );
    if (!result.ok) return { ok: false, error: result.error };

    total = result.data.total ?? issues.length;
    issues.push(...(result.data.issues || []));
    page++;
  }

  return { ok: true, issues, total };
}

/**
 * Fetches a readable security/quality report for the configured SonarQube
 * project directly via the Sonar Web API (measures, vulnerabilities,
 * security hotspots, quality gate status). Requires SONAR_URL/SONAR_TOKEN/
 * SONAR_PROJECT_KEY to be set server-side - the token is never sent to the
 * browser.
 */
export async function getSonarReport() {
  const projectKey = process.env.SONAR_PROJECT_KEY;
  if (!projectKey) {
    throw Object.assign(new Error("SONAR_PROJECT_KEY is not set on the server (.env)"), { status: 500 });
  }

  const [measures, qualityGate, issuesResult, hotspots] = await Promise.all([
    sonarGet(`/api/measures/component?component=${encodeURIComponent(projectKey)}&metricKeys=${MEASURE_KEYS.join(",")}`),
    sonarGet(`/api/qualitygates/project_status?projectKey=${encodeURIComponent(projectKey)}`),
    fetchAllIssues(projectKey),
    sonarGet(`/api/hotspots/search?projectKey=${encodeURIComponent(projectKey)}&status=TO_REVIEW&ps=100`),
  ]);

  const severityOrder = { BLOCKER: 0, CRITICAL: 1, MAJOR: 2, MINOR: 3, INFO: 4 };
  const sortedIssues = issuesResult.ok
    ? [...issuesResult.issues].sort((a, b) => (severityOrder[a.severity] ?? 9) - (severityOrder[b.severity] ?? 9))
    : [];

  const measureMap = {};
  if (measures.ok) {
    for (const m of measures.data.component?.measures || []) {
      measureMap[m.metric] = m.value;
    }
  }

  return {
    tool: "SonarQube",
    scannedAt: new Date().toISOString(),
    server: process.env.SONAR_URL,
    projectKey,
    measures: measures.ok ? measureMap : null,
    measuresError: measures.ok ? null : measures.error,
    qualityGateStatus: qualityGate.ok ? qualityGate.data.projectStatus?.status : null,
    qualityGateConditions: qualityGate.ok ? qualityGate.data.projectStatus?.conditions || [] : [],
    qualityGateError: qualityGate.ok ? null : qualityGate.error,
    issues: sortedIssues.map((i) => ({
      key: i.key,
      type: i.type,
      rule: i.rule,
      severity: i.severity,
      message: i.message,
      component: i.component,
      line: i.line ?? null,
      status: i.status,
      tags: i.tags || [],
    })),
    issuesTotal: issuesResult.ok ? issuesResult.total : 0,
    issuesError: issuesResult.ok ? null : issuesResult.error,
    securityHotspots: hotspots.ok
      ? (hotspots.data.hotspots || []).map((h) => ({
          key: h.key,
          rule: h.ruleKey,
          vulnerabilityProbability: h.vulnerabilityProbability,
          message: h.message,
          component: h.component,
          line: h.line ?? null,
          status: h.status,
        }))
      : [],
    securityHotspotsError: hotspots.ok ? null : hotspots.error,
  };
}
