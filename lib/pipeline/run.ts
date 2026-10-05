import { randomUUID } from "node:crypto";
import * as cheerio from "cheerio";
import { collectSnapshot, type PageFetcher, type SiteSnapshot } from "@/lib/snapshot";
import { runTechnicalChecks } from "@/lib/checks/technical";
import { runGeoChecks } from "@/lib/checks/geo";
import { runContentChecks } from "@/lib/checks/content";
import { runPerformanceChecks, type PageSpeedDeps } from "@/lib/checks/performance";
import { generateIdeas } from "@/lib/ideas";
import type { LlmClient } from "@/lib/llm/router";
import { buildModuleResult, failedModule, overallScore, topFixes } from "@/lib/scoring";
import { buildFixPrompt } from "@/lib/fix-prompt";
import type { CheckOutcome, CouldntCheck, ModuleResult, Report } from "./schemas";
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
  /** Free-tier AI. Null or missing means the AI parts are reported as could not check. */
  llm?: LlmClient | null;
  /** Null or missing means performance is reported as could not check. */
  pagespeed?: PageSpeedDeps | null;
  /** Lets tests replace a module. Production uses the real checks. */
  modules?: Partial<Record<CheckModule, (s: SiteSnapshot) => CheckOutcome[]>>;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : "unknown error");

/** A short plain-text summary of the site for the ideas prompt. It comes from the site, so it is fenced as untrusted there. */
function siteSummary(s: SiteSnapshot): string {
  const $ = cheerio.load(s.home.body);
  $("script, style, noscript, template, svg").remove();
  const title = $("head > title").first().text().trim();
  const description = ($('meta[name="description" i]').attr("content") ?? "").trim();
  const text = $("body").text().replace(/\s+/g, " ").trim().slice(0, 1200);
  return `${title}. ${description} ${text}`.trim();
}

/**
 * Runs one scan. The fetch step is the only one allowed to fail the scan: if we cannot
 * read the site there is nothing to audit. Every later module is isolated, so one
 * failure becomes a "couldn't check" entry and the rest of the report still arrives.
 */
export async function runScan(target: URL, deps: RunDeps): Promise<Report> {
  const { fetchPage, emit } = deps;
  const llm = deps.llm ?? null;
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
  let injectionFlags = 0;

  const summarise = (result: ModuleResult, total: number) =>
    `${result.passed.length} of ${total} checks passed, ${result.findings.length} issues found` +
    (result.couldntCheck.length ? `, ${result.couldntCheck.length} could not be checked` : "");

  for (const name of ["technical", "geo"] as const) {
    emit({ event: "step-start", data: { step: name } });
    try {
      const outcomes = checks[name](snapshot);
      const result = buildModuleResult(name, outcomes);
      modules.push(result);
      emit({ event: "step-done", data: { step: name, message: summarise(result, outcomes.length) } });
    } catch (err) {
      modules.push(failedModule(name, errorText(err)));
      emit({ event: "step-warn", data: { step: name, message: errorText(err) } });
    }
  }

  emit({ event: "step-start", data: { step: "content" } });
  try {
    const content = await runContentChecks(snapshot, llm);
    injectionFlags += content.injectionFlags;
    const result = buildModuleResult("content", content.outcomes, content.couldntCheck);
    modules.push(result);
    const flagged = content.injectionFlags ? `, ${content.injectionFlags} instruction-like text found on the page and ignored` : "";
    emit({ event: "step-done", data: { step: "content", message: summarise(result, content.outcomes.length) + flagged } });
  } catch (err) {
    modules.push(failedModule("content", errorText(err)));
    emit({ event: "step-warn", data: { step: "content", message: errorText(err) } });
  }

  emit({ event: "step-start", data: { step: "performance" } });
  if (!deps.pagespeed) {
    const why = "PageSpeed is not configured";
    modules.push(failedModule("performance", why));
    emit({ event: "step-warn", data: { step: "performance", message: why } });
  } else {
    try {
      const perf = await runPerformanceChecks(snapshot.home.finalUrl, deps.pagespeed);
      if (perf.outcomes.length === 0) {
        const why = perf.couldntCheck[0]?.why ?? "no data";
        modules.push(failedModule("performance", why));
        emit({ event: "step-warn", data: { step: "performance", message: why } });
      } else {
        const result = buildModuleResult("performance", perf.outcomes, perf.couldntCheck);
        modules.push(result);
        emit({ event: "step-done", data: { step: "performance", message: summarise(result, perf.outcomes.length) } });
      }
    } catch (err) {
      modules.push(failedModule("performance", errorText(err)));
      emit({ event: "step-warn", data: { step: "performance", message: errorText(err) } });
    }
  }

  emit({ event: "step-start", data: { step: "synthesis" } });
  const fixes = topFixes(modules);
  const ideaCouldntCheck: CouldntCheck[] = [];
  let ideas: Report["ideas"] = [];
  try {
    const result = await generateIdeas(llm, { url: snapshot.home.finalUrl, summary: siteSummary(snapshot), findings: fixes });
    ideas = result.ideas;
    ideaCouldntCheck.push(...result.couldntCheck);
  } catch (err) {
    ideaCouldntCheck.push({ what: "Marketing ideas", why: errorText(err) });
  }

  const report: Report = {
    id: (deps.newId ?? randomUUID)(),
    url: snapshot.home.finalUrl,
    domain: snapshot.domain,
    createdAt: new Date().toISOString(),
    overallScore: overallScore(modules),
    modules,
    topFixes: fixes,
    fixPrompt: buildFixPrompt({ url: snapshot.home.finalUrl, findings: fixes }),
    couldntCheck: [...couldntCheck, ...modules.flatMap((m) => m.couldntCheck), ...ideaCouldntCheck],
    pagesScanned,
    injectionFlags,
    ideas,
  };
  emit({
    event: "step-done",
    data: { step: "synthesis", message: `Overall score ${report.overallScore ?? "n/a"}, ${fixes.length} prioritised fixes, ${ideas.length} marketing ideas` },
  });
  return report;
}
