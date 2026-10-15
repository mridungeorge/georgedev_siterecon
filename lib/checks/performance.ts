import type { CheckOutcome, CouldntCheck, Finding } from "@/lib/pipeline/schemas";
import { clip, makeChecker } from "./helpers";

// Core Web Vitals and speed from Google PageSpeed Insights (free with an API key). These are
// lab measurements of one mobile run, and the report says so.

export interface PageSpeedDeps {
  apiKey: string | undefined;
  /** Uses one unit of the daily PageSpeed budget. False means it is spent. */
  quotaOk: () => boolean;
  /** The signal ends the request early when the visitor leaves or the step runs out of time. */
  fetchJson: (url: string, signal?: AbortSignal) => Promise<unknown>;
}

/** Where the slowness is, taken from the audit details PageSpeed returns. Text comes from the audited site and is cut short. */
export interface Vitals {
  /** Where the numbers came from: a PageSpeed run, or the audit's own browser. */
  source: "pagespeed" | "browser";
  lcp: { ms: number; element: string | null; resource: string | null };
  cls: { value: number; shifts: { selector: string; score: number }[] };
  /** Field data from real Chrome users, when Google has enough of it. */
  inp: { ms: number; rating: "good" | "needs improvement" | "poor"; source: "field" | "lab" } | null;
  blockers: { url: string; wastedMs: number }[];
  heavyScripts: { url: string; ms: number }[];
}

export interface PerformanceResult {
  outcomes: CheckOutcome[];
  couldntCheck: CouldntCheck[];
  vitals?: Vitals;
}

type Audits = Record<string, { numericValue?: unknown; details?: { items?: unknown } }>;
const asRecord = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const itemsOf = (audit: { details?: { items?: unknown } } | undefined): unknown[] => (Array.isArray(audit?.details?.items) ? (audit!.details!.items as unknown[]) : []);
const str = (v: unknown, max = 300): string => (typeof v === "string" ? clip(v, max) : "");

/** The first element node in an audit's items, whether they are nested in a table or flat. */
function firstNode(audit: { details?: { items?: unknown } } | undefined): { selector: string; snippet: string } | null {
  for (const item of itemsOf(audit)) {
    const rec = asRecord(item);
    const nested = Array.isArray(rec?.items) ? (rec!.items as unknown[]) : [];
    for (const candidate of [rec, ...nested.map(asRecord)]) {
      const node = asRecord(candidate?.node);
      if (node && (typeof node.selector === "string" || typeof node.snippet === "string")) {
        return { selector: str(node.selector, 200), snippet: str(node.snippet, 240) };
      }
    }
  }
  return null;
}

function resourceFrom(snippet: string, page: string): string | null {
  const m = /\bsrc=["']([^"']+)["']/i.exec(snippet) ?? /url\(["']?([^)"']+)["']?\)/i.exec(snippet);
  if (!m?.[1]) return null;
  try {
    const u = new URL(m[1], page);
    return /^https?:$/.test(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}

function readVitals(url: string, audits: Audits | undefined, data: unknown, lcpMs: number, clsValue: number): Vitals {
  const lcpNode = firstNode(audits?.["largest-contentful-paint-element"]);
  const shifts = itemsOf(audits?.["layout-shifts"])
    .map((i) => {
      const rec = asRecord(i);
      const node = asRecord(rec?.node);
      const score = typeof rec?.score === "number" ? rec.score : null;
      return node && score !== null ? { selector: str(node.selector ?? node.snippet, 200), score } : null;
    })
    .filter((x): x is { selector: string; score: number } => x !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4);
  const blockers = itemsOf(audits?.["render-blocking-resources"])
    .map((i) => asRecord(i))
    .filter((r): r is Record<string, unknown> => r !== null && typeof r.url === "string" && typeof r.wastedMs === "number")
    .map((r) => ({ url: str(r.url, 300), wastedMs: Math.round(r.wastedMs as number) }))
    .slice(0, 5);
  const heavyScripts = itemsOf(audits?.["bootup-time"])
    .map((i) => asRecord(i))
    .filter((r): r is Record<string, unknown> => r !== null && typeof r.url === "string" && typeof r.total === "number")
    .sort((a, b) => (b.total as number) - (a.total as number))
    .slice(0, 3)
    .map((r) => ({ url: str(r.url, 300), ms: Math.round(r.total as number) }));
  const metrics = asRecord(asRecord(asRecord(data)?.loadingExperience)?.metrics);
  const inpMs = num(asRecord(metrics?.INTERACTION_TO_NEXT_PAINT)?.percentile);
  return {
    source: "pagespeed",
    lcp: { ms: lcpMs, element: lcpNode?.selector || null, resource: lcpNode ? resourceFrom(lcpNode.snippet, url) : null },
    cls: { value: clsValue, shifts },
    inp: inpMs === null ? null : { ms: Math.round(inpMs), rating: inpMs <= 200 ? "good" : inpMs <= 500 ? "needs improvement" : "poor", source: "field" },
    blockers,
    heavyScripts,
  };
}

const SOURCE = "PageSpeed Insights";

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export async function runPerformanceChecks(url: string, deps: PageSpeedDeps, signal?: AbortSignal): Promise<PerformanceResult> {
  const unavailable = (why: string): PerformanceResult => ({ outcomes: [], couldntCheck: [{ what: SOURCE, why }] });

  if (!deps.apiKey) return unavailable("no PageSpeed API key is configured");
  if (!deps.quotaOk()) return unavailable("the daily PageSpeed budget has been used up");

  let data: unknown;
  try {
    const target = new URL(url).toString();
    data = await deps.fetchJson(
      `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(target)}&strategy=mobile&category=performance&key=${encodeURIComponent(deps.apiKey)}`,
      signal,
    );
  } catch (err) {
    return unavailable(`the request failed (${err instanceof Error ? err.message : "unknown error"})`);
  }

  const lh = (data as { lighthouseResult?: { categories?: Record<string, { score?: unknown }>; audits?: Audits } })?.lighthouseResult;
  const score = num(lh?.categories?.performance?.score);
  const lcp = num(lh?.audits?.["largest-contentful-paint"]?.numericValue);
  const cls = num(lh?.audits?.["cumulative-layout-shift"]?.numericValue);
  const tbt = num(lh?.audits?.["total-blocking-time"]?.numericValue);
  const fcp = num(lh?.audits?.["first-contentful-paint"]?.numericValue);
  if (score === null || lcp === null || cls === null || tbt === null || fcp === null) {
    return unavailable("it returned incomplete data");
  }

  const vitals = readVitals(url, lh?.audits, data, lcp, cls);
  const { outcomes, check } = makeChecker("performance");
  // Google grades each vital as good, needs improvement or poor. Needs improvement earns half the
  // weight, so a page that is nearly there is not scored like one that is hopeless.
  const band = (value: number, good: number, poor: number) => (value <= good ? 1 : value <= poor ? 0.5 : 0);
  const sec = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
  const note = (text: string) => [{ url, note: `${text}. Measured by Google PageSpeed Insights, mobile lab data.` }];
  const slow = (title: string, detail: string, fix: string, evidence: Finding["evidence"]): Omit<Finding, "id" | "module"> =>
    ({ severity: "medium", effort: "high", title, detail, fix, evidence });

  check("perf-score", 40, score >= 0.9, {
    ...slow(
      `The mobile performance score is ${Math.round(score * 100)} out of 100`,
      "Slow pages lose visitors and rank lower, especially on mobile. 90 and above is considered good.",
      "Work through the PageSpeed Insights opportunities: compress images, remove unused JavaScript and defer non-critical scripts.",
      note(`Performance score ${Math.round(score * 100)}/100`),
    ),
    severity: score < 0.5 ? "high" : "medium",
  }, score); // the PageSpeed score is itself a 0 to 1 measure, so a page at 85 keeps 85% of this weight
  check("lcp", 20, lcp <= 2500, slow(
    `The main content takes ${sec(lcp)} to appear`,
    "Largest Contentful Paint measures when the main content is visible. Under 2.5 s is good.",
    "Optimise the hero image or heading: compress and size the image, preload it, and cut render-blocking CSS and JavaScript.",
    [
      ...note(`LCP ${sec(lcp)} (good is under 2.5 s)`),
      ...(vitals.lcp.element ? [{ url, note: `LCP element: ${vitals.lcp.element}` }] : []),
      ...(vitals.lcp.resource ? [{ url: vitals.lcp.resource, note: "the file the LCP element loads" }] : []),
      ...vitals.blockers.slice(0, 2).map((b) => ({ url: b.url, note: `blocks rendering for about ${b.wastedMs} ms` })),
    ],
  ), band(lcp, 2500, 4000));
  check("cls", 15, cls <= 0.1, slow(
    `The layout shifts while loading (CLS ${cls.toFixed(2)})`,
    "Cumulative Layout Shift measures content jumping around as the page loads. Under 0.1 is good.",
    "Set width and height on images and embeds, and reserve space for ads, banners and late-loading fonts.",
    [
      ...note(`CLS ${cls.toFixed(2)} (good is under 0.1)`),
      ...vitals.cls.shifts.map((sh) => ({ url, note: `shifted element: ${sh.selector} (${sh.score.toFixed(2)})` })),
    ],
  ), band(cls, 0.1, 0.25));
  check("tbt", 15, tbt <= 200, slow(
    `The page is unresponsive for ${Math.round(tbt)} ms while loading`,
    "Total Blocking Time measures how long scripts freeze the page. Under 200 ms is good.",
    "Break up long JavaScript tasks, remove unused scripts and load third-party tags after the page is usable.",
    [
      ...note(`TBT ${Math.round(tbt)} ms (good is under 200 ms)`),
      ...(vitals.inp ? [{ url, note: `field INP from real users: ${vitals.inp.ms} ms (${vitals.inp.rating})` }] : []),
      ...vitals.heavyScripts.map((sc) => ({ url: sc.url, note: `${sc.ms} ms of script work` })),
    ],
  ), band(tbt, 200, 600));
  check("fcp", 10, fcp <= 1800, slow(
    `Nothing appears on screen for ${sec(fcp)}`,
    "First Contentful Paint measures when the first content shows. Under 1.8 s is good.",
    "Reduce server response time, inline critical CSS and remove render-blocking resources.",
    note(`FCP ${sec(fcp)} (good is under 1.8 s)`),
  ), band(fcp, 1800, 3000));

  return { outcomes, couldntCheck: [], vitals };
}
