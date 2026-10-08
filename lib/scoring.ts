import type { CheckOutcome, CouldntCheck, Effort, Finding, ModuleName, ModuleResult, Severity } from "@/lib/pipeline/schemas";

// The rubric lives in code, not in a model. A score is the share of check weight that passed.
// These module weights are published on the /methodology page.
export const MODULE_WEIGHTS: Record<ModuleName, number> = {
  technical: 30,
  geo: 20,
  content: 20,
  social: 15,
  performance: 15,
  competitors: 0, // comparison only, never part of the site's own score
};

export function buildModuleResult(module: ModuleName, outcomes: CheckOutcome[], couldntCheck: CouldntCheck[] = []): ModuleResult {
  const total = outcomes.reduce((sum, o) => sum + o.weight, 0);
  const earned = outcomes.reduce((sum, o) => sum + (o.passed ? o.weight : o.weight * Math.min(1, Math.max(0, o.credit ?? 0))), 0);
  return {
    module,
    status: couldntCheck.length > 0 ? "partial" : "ok",
    score: total === 0 ? null : Math.round((earned / total) * 100),
    findings: outcomes.flatMap((o) => (o.finding ? [o.finding] : [])),
    passed: outcomes.filter((o) => o.passed).map((o) => o.id),
    couldntCheck,
  };
}

export function failedModule(module: ModuleName, why: string): ModuleResult {
  return { module, status: "failed", score: null, findings: [], passed: [], couldntCheck: [{ what: module, why }] };
}

export function overallScore(modules: ModuleResult[]): number | null {
  let weight = 0;
  let sum = 0;
  for (const m of modules) {
    if (m.score === null) continue;
    weight += MODULE_WEIGHTS[m.module];
    sum += m.score * MODULE_WEIGHTS[m.module];
  }
  return weight === 0 ? null : Math.round(sum / weight);
}

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const EFFORT_RANK: Record<Effort, number> = { low: 0, medium: 1, high: 2 };

/** Most harmful first. Among equally harmful findings, the cheapest fix comes first. */
export function topFixes(modules: ModuleResult[], limit = 10): Finding[] {
  return modules
    .flatMap((m) => m.findings)
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || EFFORT_RANK[a.effort] - EFFORT_RANK[b.effort])
    .slice(0, limit);
}
