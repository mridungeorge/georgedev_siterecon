import type { Finding, ModuleName, Report } from "@/lib/pipeline/schemas";

interface AiRule {
  module: ModuleName;
  id: string;
  weight: number;
}

const RULES: AiRule[] = [
  { module: "geo", id: "ai-crawler-oai-searchbot", weight: 12 },
  { module: "geo", id: "ai-crawler-claude-searchbot", weight: 12 },
  { module: "geo", id: "ai-crawler-perplexitybot", weight: 12 },
  { module: "geo", id: "ai-crawler-googlebot", weight: 8 },
  { module: "geo", id: "content-in-html", weight: 12 },
  { module: "geo", id: "organisation-schema", weight: 8 },
  { module: "geo", id: "question-headings", weight: 8 },
  { module: "geo", id: "citable-passage", weight: 8 },
  { module: "geo", id: "llms-txt", weight: 4 },
  { module: "technical", id: "structured-data", weight: 6 },
  { module: "technical", id: "json-ld-valid", weight: 4 },
  { module: "technical", id: "schema-complete", weight: 4 },
  { module: "performance", id: "lcp", weight: 6 },
  { module: "performance", id: "cls", weight: 3 },
  { module: "performance", id: "inp", weight: 3 },
];

const SEVERITY_RANK: Record<Finding["severity"], number> = { critical: 0, high: 1, medium: 2, low: 3 };

export interface AiReadinessResult {
  score: number | null;
  measuredWeight: number;
  totalWeight: number;
  deterministicNote: string;
  largestWeakness: string;
}

export function computeAiReadiness(report: Pick<Report, "modules">): AiReadinessResult {
  let measured = 0;
  let earned = 0;
  const failed: Array<{ weight: number; finding: Finding }> = [];

  for (const rule of RULES) {
    const module = report.modules.find((m) => m.module === rule.module);
    if (!module || module.status === "failed") continue;
    if (module.passed.includes(rule.id)) {
      measured += rule.weight;
      earned += rule.weight;
      continue;
    }
    const finding = module.findings.find((f) => f.id === `${rule.module}:${rule.id}`);
    if (finding) {
      measured += rule.weight;
      failed.push({ weight: rule.weight, finding });
    }
  }

  const score = measured === 0 ? null : Math.round((earned / measured) * 100);
  const weakness = failed.sort((a, b) => b.weight - a.weight || SEVERITY_RANK[a.finding.severity] - SEVERITY_RANK[b.finding.severity])[0]?.finding;
  const evidence = weakness?.evidence[0];
  return {
    score,
    measuredWeight: measured,
    totalWeight: RULES.reduce((sum, rule) => sum + rule.weight, 0),
    deterministicNote: measured === 0
      ? "AI Readiness uses deterministic checks. Not enough measured data was available."
      : `AI Readiness uses deterministic checks only (${measured}/${RULES.reduce((sum, rule) => sum + rule.weight, 0)} weight measured). AI suggestions never set this score.`,
    largestWeakness: weakness
      ? `${weakness.title}. ${evidence?.note ? `Evidence: ${evidence.note}.` : ""}`.trim()
      : "No major AI-search weakness was detected in the checks that ran.",
  };
}
