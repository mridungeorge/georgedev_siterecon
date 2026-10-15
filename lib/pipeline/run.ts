import { randomUUID } from "node:crypto";
import * as cheerio from "cheerio";
import { collectSnapshot, type PageFetcher, type SiteSnapshot } from "@/lib/snapshot";
import { runTechnicalChecks } from "@/lib/checks/technical";
import { runGeoChecks } from "@/lib/checks/geo";
import { runContentChecks } from "@/lib/checks/content";
import { runMarketingChecks } from "@/lib/checks/marketing";
import { runPerformanceChecks, type PageSpeedDeps } from "@/lib/checks/performance";
import { runSocialChecks, type ProfileReader } from "@/lib/checks/social";
import { composeProfileReaders } from "@/lib/social/instagram";
import { findCompetitors } from "@/lib/competitors";
import { generateIdeas, pickIdeaFindings } from "@/lib/ideas";
import type { FetchClient } from "@/lib/fetch-client";
import type { SearchFn } from "@/lib/search/tavily";
import type { LlmClient } from "@/lib/llm/router";
import { buildModuleResult, failedModule, overallScore, topFixes } from "@/lib/scoring";
import { buildFixPrompt } from "@/lib/fix-prompt";
import { buildSummary } from "@/lib/summary";
import { buildFixKit } from "@/lib/fix-kit";
import { buildPageTable } from "@/lib/page-table";
import { buildAiReadiness } from "@/lib/ai-readiness";
import { createTelemetryRecorder } from "@/lib/telemetry";
import { runCrawlChecks } from "@/lib/checks/crawl";
import { crawlSitemapPages, sitemapLocations } from "@/lib/site-crawl";
import { runCitationChecks } from "@/lib/checks/citation";
import { runAnswerExtraction, runClarityReview } from "@/lib/checks/answer-extraction";
import { schemaGaps } from "@/lib/checks/schema-gaps";
import { analysePage, siteEntity } from "@/lib/checks/page-analysis";
import type { AuthoritySignals } from "@/lib/authority";
import { mergeBrowserVitals } from "@/lib/checks/vitals";
import type { Vitals } from "@/lib/checks/performance";
import { entitiesOf, topicsOf } from "@/lib/competitors";
import type { Insights } from "./schemas";
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
  /** Reads outside signals of authority (domain rank, Wikidata). Missing means only Hacker News is used. */
  authority?: ((input: { domain: string; entity: string | null; hackerNews: number | null; signal?: AbortSignal }) => Promise<AuthoritySignals>) | null;
  /** Ends the scan early (the visitor left, or the scan ran out of time). */
  signal?: AbortSignal;
  /** Most time, in ms, each outside-service step may take. Keeps a slow provider from using up the scan. */
  stepBudgets?: { render?: number; crawl?: number; authority?: number; citation?: number; content?: number; marketing?: number; performance?: number; social?: number; competitors?: number; ideas?: number };
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
  const { fetchPage: rawFetchPage } = deps;
  // Every step event also feeds the telemetry, so the timings cannot drift from what the visitor saw.
  const telemetry = createTelemetryRecorder();
  const emit: RunDeps["emit"] = (e) => {
    if (e.event === "step-start") telemetry.start(e.data.step);
    else if (e.event === "step-done") telemetry.done(e.data.step);
    else telemetry.warn(e.data.step);
    deps.emit(e);
  };
  // Every request to an outside service is counted, so the report can say what the scan really used.
  const calls = { llm: 0, pagespeed: 0, search: 0, fetchService: 0, authority: 0, hackerNews: 0, pages: 0 };
  const fetchPage: PageFetcher = (url, signal) => {
    calls.pages += 1;
    return rawFetchPage(url, signal);
  };
  const llm: LlmClient | null = deps.llm ? (o) => { calls.llm += 1; return deps.llm!(o); } : null;
  const pagespeed: PageSpeedDeps | null = deps.pagespeed
    ? { ...deps.pagespeed, fetchJson: (u, sig) => { calls.pagespeed += 1; return deps.pagespeed!.fetchJson(u, sig); } }
    : null;
  const search: SearchFn | null = deps.search ? (q, sig) => { calls.search += 1; return deps.search!(q, sig); } : null;
  const mentions: RunDeps["mentions"] = deps.mentions ? (d, sig) => { calls.hackerNews += 1; return deps.mentions!(d, sig); } : null;
  const authority: RunDeps["authority"] = deps.authority ? (i) => { calls.authority += 1; return deps.authority!(i); } : null;
  const fetchClient: FetchClient | null = deps.fetchClient
    ? {
        healthy: (sig) => deps.fetchClient!.healthy(sig),
        readProfile: (link, sig) => { calls.fetchService += 1; return deps.fetchClient!.readProfile(link, sig); },
        render: (u, sig) => { calls.fetchService += 1; return deps.fetchClient!.render(u, sig); },
      }
    : null;
  const budgets = deps.stepBudgets ?? {};
  const throwIfCancelled = () => {
    if (deps.signal?.aborted) throw new Error("The scan was cancelled.");
  };
  // Worst case, in seconds: fetch about 150, render 75, content 75, marketing 60, speed 60, social 45, competitors 90, ideas 45.
  // That adds up to more than the 540-second whole-scan ceiling, so it is the ceiling that ends a scan where every step runs out. In practice scans take a small fraction of this.
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
  if (!fetchClient) {
    emit({ event: "step-done", data: { step: "render", message: "Skipped: the browser tier is not set up on this server" } });
  } else {
    try {
      const rendered = await fetchClient.render(snapshot.home.finalUrl, budget(budgets.render ?? 75_000));
      if (rendered.status === "ok") {
        snapshot.rendered = {
          words: rendered.words,
          mobileOverflow: rendered.mobileOverflow,
          ...(rendered.h1 === undefined ? {} : { h1: rendered.h1 }),
          ...(rendered.links === undefined ? {} : { links: rendered.links }),
          ...(rendered.jsonLd === undefined ? {} : { jsonLd: rendered.jsonLd }),
          ...(rendered.titleChars === undefined ? {} : { titleChars: rendered.titleChars }),
          ...(rendered.lcpMs === undefined ? {} : { lcpMs: rendered.lcpMs }),
          ...(rendered.clsMilli === undefined ? {} : { clsMilli: rendered.clsMilli }),
          ...(rendered.inpMs === undefined ? {} : { inpMs: rendered.inpMs }),
          ...(rendered.hydrationErrors === undefined ? {} : { hydrationErrors: rendered.hydrationErrors }),
          ...(rendered.lcpTag === undefined ? {} : { lcpTag: rendered.lcpTag }),
        };
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

  const insights: Insights = { vitals: null, crawl: null, citation: null, schemaGaps: [] };
  let authoritySignals: AuthoritySignals | null = null;

  throwIfCancelled();
  emit({ event: "step-start", data: { step: "crawl" } });
  try {
    // Read the pages the sitemap lists that the main crawl skipped, so orphan and status findings cover the whole sitemap.
    try {
      snapshot.siteCrawl = await crawlSitemapPages(snapshot, fetchPage, { signal: budget(budgets.crawl ?? 90_000) });
    } catch (err) {
      if (deps.signal?.aborted) throw err;
      extraCouldntCheck.push({ what: "Sitemap crawl", why: errorText(err) });
    }
    const crawl = runCrawlChecks(snapshot);
    insights.crawl = crawl.insights;
    const result = buildModuleResult("crawl", crawl.outcomes);
    modules.push(result);
    emit({ event: "step-done", data: { step: "crawl", message: summarise(result, crawl.outcomes.length) } });
  } catch (err) {
    modules.push(failedModule("crawl", errorText(err)));
    emit({ event: "step-warn", data: { step: "crawl", message: errorText(err) } });
  }

  throwIfCancelled();
  emit({ event: "step-start", data: { step: "citation" } });
  // Hacker News is read once and reused by the social step.
  let hackerNews: number | null | undefined;
  try {
    const signal = budget(budgets.authority ?? 20_000);
    hackerNews = mentions ? await mentions(snapshot.domain, signal).catch(() => null) : undefined;
    const fromHn: AuthoritySignals | null = hackerNews === undefined || hackerNews === null ? null : { domainRank: null, wikidata: null, hackerNews };
    authoritySignals = authority
      ? await authority({ domain: snapshot.domain, entity: siteEntity(snapshot), hackerNews: hackerNews ?? null, signal }).catch(() => fromHn)
      : fromHn;
  } catch (err) {
    if (deps.signal?.aborted) throw err;
  }
  try {
    const citation = runCitationChecks(snapshot, authoritySignals);
    insights.schemaGaps = schemaGaps(snapshot);
    // Both AI reviews need the AI service and say so when it is absent. They share one time budget.
    const aiSignal = budget(budgets.citation ?? 60_000);
    const guard = <T,>(what: string, empty: T) => (err: unknown) => {
      if (deps.signal?.aborted) throw err;
      return { ...empty, couldntCheck: [{ what, why: errorText(err) }] };
    };
    const extraction = await runAnswerExtraction(snapshot, llm, aiSignal).catch(guard("Answer extraction simulation", { items: [] }));
    const clarity = await runClarityReview(snapshot, llm, aiSignal).catch(guard("AI review of clarity", { outcomes: [] }));
    // The clarity findings have weight 0: they appear in the report and the plan, and never move a score.
    const result = buildModuleResult("citation", [...citation.outcomes, ...clarity.outcomes], clarity.couldntCheck);
    modules.push(result);
    insights.citation = { ...citation.insights, aiExtraction: extraction.items };
    extraCouldntCheck.push(...extraction.couldntCheck);
    emit({ event: "step-done", data: { step: "citation", message: summarise(result, citation.outcomes.length + clarity.outcomes.length) } });
  } catch (err) {
    modules.push(failedModule("citation", errorText(err)));
    emit({ event: "step-warn", data: { step: "citation", message: errorText(err) } });
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
  emit({ event: "step-start", data: { step: "marketing" } });
  try {
    const marketing = await runMarketingChecks(snapshot, llm, budget(budgets.marketing ?? 60_000));
    const result = buildModuleResult("marketing", marketing.outcomes, marketing.couldntCheck);
    modules.push(result);
    emit({ event: "step-done", data: { step: "marketing", message: summarise(result, marketing.outcomes.length) } });
  } catch (err) {
    modules.push(failedModule("marketing", errorText(err)));
    emit({ event: "step-warn", data: { step: "marketing", message: errorText(err) } });
  }

  throwIfCancelled();
  emit({ event: "step-start", data: { step: "performance" } });
  if (!pagespeed) {
    const why = "PageSpeed is not configured";
    modules.push(failedModule("performance", why));
    emit({ event: "step-warn", data: { step: "performance", message: why } });
  } else {
    try {
      const perf = await runPerformanceChecks(snapshot.home.finalUrl, pagespeed, budget(budgets.performance ?? 60_000));
      if (perf.outcomes.length === 0) {
        const why = perf.couldntCheck[0]?.why ?? "no data";
        modules.push(failedModule("performance", why));
        emit({ event: "step-warn", data: { step: "performance", message: why } });
      } else {
        const result = buildModuleResult("performance", perf.outcomes, perf.couldntCheck);
        modules.push(result);
        insights.vitals = perf.vitals ?? null;
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
    const client = fetchClient ?? null;
    const reader = composeProfileReaders(deps.instagram ?? null, client ? (link, signal) => client.readProfile(link, signal) : null);
    const result = await runSocialChecks(snapshot, reader, socialSignal);
    if (mentions) {
      const hits = hackerNews !== undefined ? hackerNews : await mentions(snapshot.domain, socialSignal).catch(() => null);
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
    const homeAnalysis = analysePage(snapshot.home.finalUrl, snapshot.home.body);
    const result = await findCompetitors(
      {
        domain: snapshot.domain,
        title: $title(snapshot),
        description: "",
        summary: siteSummary(snapshot),
        technical: scoreOf("technical"),
        geo: scoreOf("geo"),
        platforms: [...new Set((social?.profiles ?? []).filter((p) => p.kind === "profile").map((p) => p.platform))],
        schemaTypes: homeAnalysis.schemaTypes,
        words: homeAnalysis.words,
        entities: entitiesOf([...cheerio.load(snapshot.home.body)("h1, h2, h3").map((_, el) => cheerio.load(snapshot.home.body)(el).text().replace(/\s+/g, " ").trim()).get(), ...homeAnalysis.paragraphs.slice(0, 6)]),
        sitemapUrls: snapshot.sitemapXml ? sitemapLocations(snapshot.sitemapXml).length : 0,
        topics: topicsOf([$title(snapshot), ...cheerio.load(snapshot.home.body)("h1, h2").map((_, el) => cheerio.load(snapshot.home.body)(el).text().replace(/\s+/g, " ").trim()).get()]),
        // What the site fails in the two modules competitors are measured on, to compare check by check.
        failures: modules.filter((m) => m.module === "technical" || m.module === "geo").flatMap((m) => m.findings.map((f) => ({ id: f.id, title: f.title }))),
      },
      {
        llm,
        search: search,
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
      { url: snapshot.home.finalUrl, summary: siteSummary(snapshot), findings: pickIdeaFindings(modules) },
      budget(budgets.ideas ?? 45_000),
    );
    ideas = result.ideas;
    ideaCouldntCheck.push(...result.couldntCheck);
  } catch (err) {
    ideaCouldntCheck.push({ what: "Marketing ideas", why: errorText(err) });
  }
  throwIfCancelled(); // do not build and store a report nobody is waiting for

  // Browser-measured vitals fill in whatever PageSpeed did not give (all of them with no key, or a lab INP).
  insights.vitals = mergeBrowserVitals(insights.vitals as Vitals | null, snapshot.rendered);

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
    fixKit: buildFixKit(snapshot, modules, social, competitors),
    pageTable: buildPageTable(snapshot, modules),
    aiReadiness: buildAiReadiness(modules),
    telemetry: null,
    insights,
  };
  emit({
    event: "step-done",
    data: { step: "synthesis", message: `Overall score ${report.overallScore ?? "n/a"}, ${fixes.length} prioritised fixes, ${ideas.length} marketing ideas` },
  });
  report.telemetry = telemetry.finish({ llm: llm !== null, pagespeed: Boolean(pagespeed), fetchService: Boolean(fetchClient) }, calls);
  return report;
}

function $title(s: SiteSnapshot): string {
  return cheerio.load(s.home.body)("head > title").first().text().replace(/\s+/g, " ").trim();
}
