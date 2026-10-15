import type { Effort, Finding, Severity } from "@/lib/pipeline/schemas";

// A 2x2 over fields every finding already has. High impact is critical or high severity; low effort is
// the cheapest band. Nothing here is estimated by a model.

export interface ImpactMatrix {
  /** High impact, low or medium effort: do these first. */
  quickWins: Finding[];
  /** High impact, high effort: plan these. */
  bigBets: Finding[];
  /** Lower impact, low or medium effort: do when passing. */
  fillIns: Finding[];
  /** Lower impact, high effort: leave until the rest is done. */
  deprioritise: Finding[];
}

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const EFFORT_RANK: Record<Effort, number> = { low: 0, medium: 1, high: 2 };
const highImpact = (f: Finding) => f.severity === "critical" || f.severity === "high";

export function buildImpactMatrix(findings: Finding[]): ImpactMatrix {
  const order = (a: Finding, b: Finding) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || EFFORT_RANK[a.effort] - EFFORT_RANK[b.effort];
  const sorted = [...findings].sort(order);
  return {
    quickWins: sorted.filter((f) => highImpact(f) && f.effort !== "high"),
    bigBets: sorted.filter((f) => highImpact(f) && f.effort === "high"),
    fillIns: sorted.filter((f) => !highImpact(f) && f.effort !== "high"),
    deprioritise: sorted.filter((f) => !highImpact(f) && f.effort === "high"),
  };
}
