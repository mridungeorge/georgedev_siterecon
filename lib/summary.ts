import type { Effort, Finding, ModuleName, ModuleResult, ReportSummary, Severity } from "@/lib/pipeline/schemas";

// The summary is plain arithmetic over the findings. No AI writes it, so it cannot claim anything the
// checks did not find, and the same findings always give the same words.

const MODULE_LABEL: Record<ModuleName, string> = {
  technical: "SEO", geo: "AI visibility", content: "Content and conversion", social: "Social media", competitors: "Competitors", performance: "Speed",
};
const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const QUICK_WIN_SEVERITIES = new Set<Severity>(["critical", "high", "medium"]);
const MAX_QUICK_WINS = 5;

const BANDS: { min: number; grade: NonNullable<ReportSummary["grade"]>; word: string }[] = [
  { min: 90, grade: "A", word: "Excellent" },
  { min: 80, grade: "B", word: "Strong" },
  { min: 70, grade: "C", word: "Decent" },
  { min: 60, grade: "D", word: "Needs work" },
  { min: 0, grade: "F", word: "Needs urgent attention" },
];

export function buildSummary(modules: ModuleResult[], overall: number | null): ReportSummary {
  const findings: Finding[] = modules.flatMap((m) => m.findings);
  // Array.prototype.sort is stable, so equally severe findings keep their module order.
  const bySeverity = [...findings].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  const withEffort = (effort: Effort) => bySeverity.filter((f) => f.effort === effort).map((f) => f.id);

  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) counts[f.severity] += 1;

  const quickWins = bySeverity.filter((f) => f.effort === "low" && QUICK_WIN_SEVERITIES.has(f.severity)).slice(0, MAX_QUICK_WINS).map((f) => f.id);

  const scored = modules.filter((m): m is ModuleResult & { score: number } => m.score !== null && m.module !== "competitors");
  let strongest: ReportSummary["strongest"] = null;
  let weakest: ReportSummary["weakest"] = null;
  for (const m of scored) {
    if (strongest === null || m.score > strongest.score) strongest = { module: m.module, score: m.score };
    if (weakest === null || m.score < weakest.score) weakest = { module: m.module, score: m.score };
  }

  const roadmap = { thisWeek: withEffort("low"), thisMonth: withEffort("medium"), thisQuarter: withEffort("high") };

  if (overall === null) {
    return { grade: null, verdict: "SiteRecon could not score this site.", strongest: null, weakest: null, counts, quickWins, roadmap };
  }

  const band = BANDS.find((b) => overall >= b.min)!;
  const parts = [`${band.word} (${band.grade}, ${overall}/100).`];
  // Comparing areas only says something when there are at least two, and they differ.
  if (scored.length >= 2 && strongest && weakest && strongest.score !== weakest.score) {
    parts.push(`Strongest: ${MODULE_LABEL[strongest.module]} (${strongest.score}), weakest: ${MODULE_LABEL[weakest.module]} (${weakest.score}).`);
  }
  if (findings.length === 0) {
    parts.push("No issues found in the areas checked.");
  } else {
    const q = quickWins.length;
    const quick = q === 0 ? "" : q === 1 ? ", 1 of them a quick win" : `, ${q} of them quick wins`;
    parts.push(`${findings.length} issue${findings.length === 1 ? "" : "s"} found${quick}.`);
  }
  return { grade: band.grade, verdict: parts.join(" "), strongest, weakest, counts, quickWins, roadmap };
}
