import { randomUUID } from "node:crypto";
import * as cheerio from "cheerio";
import { collectSnapshot, type PageFetcher, type SiteSnapshot } from "@/lib/snapshot";
import { runTechnicalChecks } from "@/lib/checks/technical";
import { runGeoChecks } from "@/lib/checks/geo";
import { runContentChecks } from "@/lib/checks/content";
import { runPerformanceChecks, type PageSpeedDeps } from "@/lib/checks/performance";
import { runSocialChecks, type ProfileReader } from "@/lib/checks/social";
import { composeProfileReaders } from "@/lib/social/instagram";
import { findCompetitors } from "@/lib/competitors";
import { generateIdeas } from "@/lib/ideas";
import type { FetchClient } from "@/lib/fetch-client";
import type { SearchFn } from "@/lib/search/tavily";
import type { LlmClient } from "@/lib/llm/router";
import { buildModuleResult, failedModule, overallScore, topFixes } from "@/lib/scoring";
import { buildFixPrompt } from "@/lib/fix-prompt";
import { buildSummary } from "@/lib/summary";
import { buildFixKit } from "@/lib/fix-kit";
import { buildPageTable } from "@/lib/page-table";
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
  /** The optional Python service: reads public social pages and renders the page in a browser. */
  fetchClient?: FetchClient | null;
  /** Optional: reads Instagram business and creator accounts through Meta's Graph API. */
  instagram?: ProfileReader | null;
  /** Optional free web search, used to find more competitors. */
  search?: SearchFn | null;
  /** Asked before each competitor site is fetched. False skips it (the per-site rate limit). */
  allowCompetitorDomain?: ((domain: string) => boolean) | null;
  /** Counts public Hacker News mentions of the domain. */
  mentions?: ((domain: string, signal?: AbortSignal) => Promise<number | null>) | null;
  /** Ends the scan early (the visitor left, or the scan ran out of time). */
  signal?: AbortSignal;
  /** Most time, in ms, each outside-service step may take. Keeps a slow provider from using up the scan. */
  stepBudgets?: { render?: number; content?: number; performance?: number; social?: number; competitors?: number; ideas?: number };
  /** Lets tests replace a module. Production uses the real checks. */
  modules?: Partial<Record<CheckModule, (s: SiteSnapshot) => CheckOutcome[]>>;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : "unknown error");

/** A short plain-text summary of the site for the ideas and competitor prompts. It comes from the site, so it is fenced as untrusted there. */
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
  const budgets = deps.stepBudgets ?? {};
  const throwIfCancelled = () => {
    if (deps.signal?.aborted) throw new Error("The scan was cancelled.");
  };
  // Worst case, in seconds: fetch about 150, render 75, content 75, speed 60, social 45, competitors 90, ideas 45.
  // That is 540, the whole-scan ceiling. In practice scans take a small fraction of this.
  const budget = (ms: number) => (deps.signal ? AbortSignal.any([deps.signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms));
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
  const extraCouldntCheck: CouldntCheck[] = [];
  let injectionFlags = 0;

  const summarise = (result: ModuleResult, total: number) =>
    `${result.passed.length} of ${total} checks passed, ${result.findings.length} issues found` +
    (result.couldntCheck.length ? `, ${result.couldntCheck.length} could not be checked` : "");

  // Browser render (optional). What a real browser sees feeds the technical and AI-readiness checks below.
  throwIfCancelled();
  emit({ event: "step-start", data: { step: "render" } });
  if (!deps.fetchClient) {
    emit({ event: "step-done", data: { step: "render", message: "Skipped: the browser tier is not set up on this server" } });
  } else {
    try {
      const rendered = await deps.fetchClient.render(snapshot.home.finalUrl, budget(budgets.render ?? 75_000));
      if (rendered.status === "ok") {
        snapshot.rendered = { words: rendered.words, mobileOverflow: rendered.mobileOverflow };
        emit({ event: "step-done", data: { step: "render", message: `A real browser saw ${rendered.words} words${rendered.mobileOverflow ? " and a page wider than a phone screen" : ""}` } });
      } else {
        extraCouldntCheck.push({ what: "Browser rendering", why: rendered.reason });
        emit({ event: "step-done", data: { step: "render", message: `Skipped: ${rendered.reason}` } });
      }
    } catch (err) {
      extraCouldntCheck.push({ what: "Browser rendering", why: errorText(err) });
      emit({ event: "step-warn", data: { step: "render", message: errorText(err) } });
    }
  }

  for (const name of ["technical", "geo"] as const) {
    throwIfCancelled();
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

  throwIfCancelled();
  emit({ event: "step-start", data: { step: "content" } });
  try {
    const content = await runContentChecks(snapshot, llm, budget(budgets.content ?? 75_000));
    injectionFlags += content.injectionFlags;
    const result = buildModuleResult("content", content.outcomes, content.couldntCheck);
    modules.push(result);
    const flagged = content.injectionFlags ? `, ${content.injectionFlags} instruction-like text found on the page and ignored` : "";
    emit({ event: "step-done", data: { step: "content", message: summarise(result, content.outcomes.length) + flagged } });
  } catch (err) {
    modules.push(failedModule("content", errorText(err)));
    emit({ event: "step-warn", data: { step: "content", message: errorText(err) } });
  }

  throwIfCancelled();
  emit({ event: "step-start", data: { step: "performance" } });
  if (!deps.pagespeed) {
    const why = "PageSpeed is not configured";
    modules.push(failedModule("performance", why));
    emit({ event: "step-warn", data: { step: "performance", message: why } });
  } else {
    try {
      const perf = await runPerformanceChecks(snapshot.home.finalUrl, deps.pagespeed, budget(budgets.performance ?? 60_000));
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

  throwIfCancelled();
  emit({ event: "step-start", data: { step: "social" } });
  let social: Report["social"] = null;
  try {
    const socialSignal = budget(budgets.social ?? 45_000);
    const client = deps.fetchClient ?? null;
    const reader = composeProfileReaders(deps.instagram ?? null, client ? (link, signal) => client.readProfile(link, signal) : null);
    const result = await runSocialChecks(snapshot, reader, socialSignal);
    if (deps.mentions) {
      const hits = await deps.mentions(snapshot.domain, socialSignal).catch(() => null);
      result.summary.mentions = hits === null ? null : { hackerNews: hits };
    }
    social = result.summary;
    const moduleResult = buildModuleResult("social", result.outcomes, result.couldntCheck);
    modules.push(moduleResult);
    emit({ event: "step-done", data: { step: "social", message: `${result.summary.profiles.length} social links found. ${summarise(moduleResult, result.outcomes.length)}` } });
  } catch (err) {
    modules.push(failedModule("social", errorText(err)));
    emit({ event: "step-warn", data: { step: "social", message: errorText(err) } });
  }

  throwIfCancelled();
  emit({ event: "step-start", data: { step: "competitors" } });
  let competitors: Report["competitors"] = null;
  try {
    const competitorSignal = budget(budgets.competitors ?? 90_000);
    const scoreOf = (m: "technical" | "geo") => modules.find((x) => x.module === m)?.score ?? null;
    const result = await findCompetitors(
      {
        domain: snapshot.domain,
        title: $title(snapshot),
        description: "",
        summary: siteSummary(snapshot),
        technical: scoreOf("technical"),
        geo: scoreOf("geo"),
        platforms: [...new Set((social?.profiles ?? []).filter((p) => p.kind === "profile").map((p) => p.platform))],
        // What the site fails in the two modules competitors are measured on, to compare check by check.
        failures: modules.filter((m) => m.module === "technical" || m.module === "geo").flatMap((m) => m.findings.map((f) => ({ id: f.id, title: f.title }))),
      },
      {
        llm,
        search: deps.search ?? null,
        fetchPage: (url) => fetchPage(url, competitorSignal),
        signal: competitorSignal,
        allowDomain: deps.allowCompetitorDomain ?? undefined,
      },
    );
    competitors = result.table;
    extraCouldntCheck.push(...result.couldntCheck);
    emit({
      event: result.table ? "step-done" : "step-warn",
      data: { step: "competitors", message: result.table ? `${result.table.rows.length} competitors compared` : (result.couldntCheck[0]?.why ?? "no competitors found") },
    });
  } catch (err) {
    extraCouldntCheck.push({ what: "Competitor comparison", why: errorText(err) });
    emit({ event: "step-warn", data: { step: "competitors", message: errorText(err) } });
  }

  throwIfCancelled();
  emit({ event: "step-start", data: { step: "synthesis" } });
  const fixes = topFixes(modules);
  const ideaCouldntCheck: CouldntCheck[] = [];
  let ideas: Report["ideas"] = [];
  try {
    const result = await generateIdeas(
      llm,
      { url: snapshot.home.finalUrl, summary: siteSummary(snapshot), findings: fixes },
      budget(budgets.ideas ?? 45_000),
    );
    ideas = result.ideas;
    ideaCouldntCheck.push(...result.couldntCheck);
  } catch (err) {
    ideaCouldntCheck.push({ what: "Marketing ideas", why: errorText(err) });
  }
  throwIfCancelled(); // do not build and store a report nobody is waiting for

  const overall = overallScore(modules);
  const report: Report = {
    id: (deps.newId ?? randomUUID)(),
    url: snapshot.home.finalUrl,
    domain: snapshot.domain,
    createdAt: new Date().toISOString(),
    overallScore: overall,
    modules,
    topFixes: fixes,
    fixPrompt: buildFixPrompt({ url: snapshot.home.finalUrl, findings: fixes }),
    couldntCheck: [...couldntCheck, ...modules.flatMap((m) => m.couldntCheck), ...extraCouldntCheck, ...ideaCouldntCheck],
    pagesScanned,
    injectionFlags,
    ideas,
    social,
    competitors,
    summary: buildSummary(modules, overall),
    fixKit: buildFixKit(snapshot, modules, social),
    pageTable: buildPageTable(snapshot, modules),
  };
  emit({
    event: "step-done",
    data: { step: "synthesis", message: `Overall score ${report.overallScore ?? "n/a"}, ${fixes.length} prioritised fixes, ${ideas.length} marketing ideas` },
  });
  return report;
}

function $title(s: SiteSnapshot): string {
  return cheerio.load(s.home.body)("head > title").first().text().replace(/\s+/g, " ").trim();
}
