import { randomUUID } from "node:crypto";
import { collectSnapshot, type PageFetcher, type SiteSnapshot } from "@/lib/snapshot";
import { runTechnicalChecks } from "@/lib/checks/technical";
import { runGeoChecks } from "@/lib/checks/geo";
import { buildModuleResult, failedModule, overallScore, topFixes } from "@/lib/scoring";
import { buildFixPrompt } from "@/lib/fix-prompt";
import type { CheckOutcome, ModuleResult, Report } from "./schemas";
import { type StepName } from "./steps";

export { STEPS, type StepName } from "./steps";

export type ScanEvent =
  | { event: "step-start"; data: { step: StepName } }
  | { event: "step-done"; data: { step: StepName; message: string } }
  | { event: "step-warn"; data: { step: StepName; message: string } };

type CheckModule = "technical" | "geo";

export interface RunDeps {
  fetchPage: PageFetcher;
  emit: (e: ScanEvent) => void;
  newId?: () => string;
  /** Lets tests replace a module. Production uses the real checks. */
  modules?: Partial<Record<CheckModule, (s: SiteSnapshot) => CheckOutcome[]>>;
}

/**
 * Runs one scan. The fetch step is the only one allowed to fail the scan: if we cannot
 * read the site there is nothing to audit. Every later module is isolated, so one
 * failure becomes a "couldn't check" entry and the rest of the report still arrives.
 */
export async function runScan(target: URL, deps: RunDeps): Promise<Report> {
  const { fetchPage, emit } = deps;
  const checks: Record<CheckModule, (s: SiteSnapshot) => CheckOutcome[]> = {
    technical: deps.modules?.technical ?? runTechnicalChecks,
    geo: deps.modules?.geo ?? runGeoChecks,
  };

  emit({ event: "step-start", data: { step: "fetch" } });
  const { snapshot, couldntCheck } = await collectSnapshot(target, fetchPage);
  const pagesScanned = [snapshot.home.finalUrl, ...snapshot.pages.map((p) => p.finalUrl)];
  emit({
    event: "step-done",
    data: {
      step: "fetch",
      message: `Read ${pagesScanned.length} page${pagesScanned.length === 1 ? "" : "s"} from ${snapshot.domain}` +
        `${snapshot.robotsTxt ? ", robots.txt" : ""}${snapshot.sitemapXml ? ", sitemap" : ""}${snapshot.llmsTxt ? ", llms.txt" : ""}`,
    },
  });

  const modules: ModuleResult[] = [];
  for (const name of ["technical", "geo"] as const) {
    emit({ event: "step-start", data: { step: name } });
    try {
      const outcomes = checks[name](snapshot);
      const result = buildModuleResult(name, outcomes);
      modules.push(result);
      emit({
        event: "step-done",
        data: { step: name, message: `${result.passed.length} of ${outcomes.length} checks passed, ${result.findings.length} issues found` },
      });
    } catch (err) {
      const why = err instanceof Error ? err.message : "unknown error";
      modules.push(failedModule(name, why));
      emit({ event: "step-warn", data: { step: name, message: why } });
    }
  }

  emit({ event: "step-start", data: { step: "synthesis" } });
  const fixes = topFixes(modules);
  const report: Report = {
    id: (deps.newId ?? randomUUID)(),
    url: snapshot.home.finalUrl,
    domain: snapshot.domain,
    createdAt: new Date().toISOString(),
    overallScore: overallScore(modules),
    modules,
    topFixes: fixes,
    fixPrompt: buildFixPrompt({ url: snapshot.home.finalUrl, findings: fixes }),
    couldntCheck: [...couldntCheck, ...modules.flatMap((m) => m.couldntCheck)],
    pagesScanned,
    injectionFlags: 0, // prompt-injection detection arrives with the LLM modules in Plan 2
  };
  emit({ event: "step-done", data: { step: "synthesis", message: `Overall score ${report.overallScore ?? "n/a"}, ${fixes.length} prioritised fixes` } });
  return report;
}
