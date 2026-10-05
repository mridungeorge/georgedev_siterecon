import type { CheckOutcome, CouldntCheck, Finding } from "@/lib/pipeline/schemas";
import { makeChecker } from "./helpers";

// Core Web Vitals and speed from Google PageSpeed Insights (free with an API key). These are
// lab measurements of one mobile run, and the report says so.

export interface PageSpeedDeps {
  apiKey: string | undefined;
  /** Uses one unit of the daily PageSpeed budget. False means it is spent. */
  quotaOk: () => boolean;
  fetchJson: (url: string) => Promise<unknown>;
}

export interface PerformanceResult {
  outcomes: CheckOutcome[];
  couldntCheck: CouldntCheck[];
}

const SOURCE = "PageSpeed Insights";

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export async function runPerformanceChecks(url: string, deps: PageSpeedDeps): Promise<PerformanceResult> {
  const unavailable = (why: string): PerformanceResult => ({ outcomes: [], couldntCheck: [{ what: SOURCE, why }] });

  if (!deps.apiKey) return unavailable("no PageSpeed API key is configured");
  if (!deps.quotaOk()) return unavailable("the daily PageSpeed budget has been used up");

  let data: unknown;
  try {
    const target = new URL(url).toString();
    data = await deps.fetchJson(
      `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(target)}&strategy=mobile&category=performance&key=${encodeURIComponent(deps.apiKey)}`,
    );
  } catch (err) {
    return unavailable(`the request failed (${err instanceof Error ? err.message : "unknown error"})`);
  }

  const lh = (data as { lighthouseResult?: { categories?: Record<string, { score?: unknown }>; audits?: Record<string, { numericValue?: unknown }> } })?.lighthouseResult;
  const score = num(lh?.categories?.performance?.score);
  const lcp = num(lh?.audits?.["largest-contentful-paint"]?.numericValue);
  const cls = num(lh?.audits?.["cumulative-layout-shift"]?.numericValue);
  const tbt = num(lh?.audits?.["total-blocking-time"]?.numericValue);
  const fcp = num(lh?.audits?.["first-contentful-paint"]?.numericValue);
  if (score === null || lcp === null || cls === null || tbt === null || fcp === null) {
    return unavailable("it returned incomplete data");
  }

  const { outcomes, check } = makeChecker("performance");
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
  });
  check("lcp", 20, lcp <= 2500, slow(
    `The main content takes ${sec(lcp)} to appear`,
    "Largest Contentful Paint measures when the main content is visible. Under 2.5 s is good.",
    "Optimise the hero image or heading: compress and size the image, preload it, and cut render-blocking CSS and JavaScript.",
    note(`LCP ${sec(lcp)} (good is under 2.5 s)`),
  ));
  check("cls", 15, cls <= 0.1, slow(
    `The layout shifts while loading (CLS ${cls.toFixed(2)})`,
    "Cumulative Layout Shift measures content jumping around as the page loads. Under 0.1 is good.",
    "Set width and height on images and embeds, and reserve space for ads, banners and late-loading fonts.",
    note(`CLS ${cls.toFixed(2)} (good is under 0.1)`),
  ));
  check("tbt", 15, tbt <= 200, slow(
    `The page is unresponsive for ${Math.round(tbt)} ms while loading`,
    "Total Blocking Time measures how long scripts freeze the page. Under 200 ms is good.",
    "Break up long JavaScript tasks, remove unused scripts and load third-party tags after the page is usable.",
    note(`TBT ${Math.round(tbt)} ms (good is under 200 ms)`),
  ));
  check("fcp", 10, fcp <= 1800, slow(
    `Nothing appears on screen for ${sec(fcp)}`,
    "First Contentful Paint measures when the first content shows. Under 1.8 s is good.",
    "Reduce server response time, inline critical CSS and remove render-blocking resources.",
    note(`FCP ${sec(fcp)} (good is under 1.8 s)`),
  ));

  return { outcomes, couldntCheck: [] };
}
