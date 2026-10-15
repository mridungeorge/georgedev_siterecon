import * as cheerio from "cheerio";
import type { SiteSnapshot } from "@/lib/snapshot";
import type { CheckOutcome, Finding } from "@/lib/pipeline/schemas";
import { readJsonLd } from "./jsonld";
import { clip } from "./helpers";
import { sitemapLocations, type CrawlCoverage } from "@/lib/site-crawl";

// Crawlability and rendering: how the pages the audit read fit together, and whether what a bot is
// served matches what a browser shows. Rules only. The weights are published on /methodology.

export const CRAWL_WEIGHTS = {
  "canonical-consistency": 20,
  "orphan-pages": 15,
  "internal-redirects": 10,
  "render-links": 15,
  "render-schema": 10,
  "render-headings": 15,
  "render-hydration": 15,
} as const;
export type CrawlCheckId = keyof typeof CRAWL_WEIGHTS;

export interface CrawlInsights {
  /** Pages read and broken links followed, by what they answered. */
  statusClasses: { ok: number; redirected: number; clientError: number; serverError: number; unreachable: number };
  /** How many pages the sitemap lists, when it was read. */
  sitemapUrls: number | null;
  /** How much of the sitemap the bounded crawl covered, when it ran. */
  coverage: CrawlCoverage | null;
  /** Whether orphan detection could be answered: it needs a link graph that covers the whole sitemap. */
  orphanCheck: "ran" | "incomplete" | "no-sitemap";
  /** What the HTML had against what the browser saw, when a browser render ran. */
  renderDiff: { label: string; raw: number; rendered: number }[];
}

/** The most inner pages the audit reads. A crawl that reached the cap cannot say which pages are orphaned. */
const CRAWL_CAP = 10;
const MAX_SITEMAP_FOR_ORPHANS = 60;

const stripSlash = (p: string) => p.replace(/\/+$/, "") || "/";
const normalise = (raw: string, base?: string): string | null => {
  try {
    const u = new URL(raw, base);
    return `${u.hostname.toLowerCase().replace(/^www\./, "")}${stripSlash(u.pathname)}`;
  } catch {
    return null;
  }
};

export function runCrawlChecks(s: SiteSnapshot): { outcomes: CheckOutcome[]; insights: CrawlInsights } {
  const outcomes: CheckOutcome[] = [];
  const all = [s.home, ...s.pages];
  // Pages the bounded sitemap crawl fetched in addition to the ones the main crawl read.
  const extra = s.siteCrawl?.pages ?? [];
  const everything = [...all, ...extra];
  const finding = (id: CrawlCheckId, severity: Finding["severity"], effort: Finding["effort"], f: Pick<Finding, "title" | "detail" | "fix" | "evidence">): Finding =>
    ({ id: `crawl:${id}`, module: "crawl", severity, effort, ...f });
  const record = (id: CrawlCheckId, ok: boolean, onFail: () => Finding): void => {
    const weight = CRAWL_WEIGHTS[id];
    outcomes.push(ok ? { id, weight, passed: true } : { id, weight, passed: false, finding: onFail() });
  };

  // 1. Canonicals across pages. The homepage canonical is already checked by technical:canonical-valid.
  const canonicalProblems: { url: string; note: string }[] = [];
  for (const res of [...s.pages, ...extra]) {
    const href = cheerio.load(res.body)('link[rel="canonical" i]').first().attr("href")?.trim();
    if (!href) continue;
    let target: URL;
    try {
      target = new URL(href, res.finalUrl);
    } catch {
      continue;
    }
    const self = normalise(res.finalUrl);
    const there = normalise(target.href);
    if (target.hostname.replace(/^www\./, "") !== new URL(res.finalUrl).hostname.replace(/^www\./, "")) {
      canonicalProblems.push({ url: res.finalUrl, note: `the canonical points to a different site: ${clip(target.href, 120)}` });
    } else if (self !== there) {
      const homeKey = normalise(s.home.finalUrl);
      canonicalProblems.push({
        url: res.finalUrl,
        note: there === homeKey ? `the canonical points to the homepage, so this page asks to be treated as a copy of it` : `the canonical points to ${clip(target.href, 120)}, not to this page`,
      });
    }
  }
  if ([...s.pages, ...extra].some((r) => cheerio.load(r.body)('link[rel="canonical" i]').length > 0)) {
    record("canonical-consistency", canonicalProblems.length === 0, () =>
      finding("canonical-consistency", "high", "low", {
        title: `${canonicalProblems.length} page${canonicalProblems.length === 1 ? "" : "s"} declare a canonical that is not the page itself`,
        detail: "A canonical tells search engines which address is the real one. An inner page that points elsewhere (especially at the homepage) can be dropped from the index as a duplicate.",
        fix: "Make each page's canonical its own address. Only point a canonical elsewhere for a true duplicate, such as a tracking-parameter variant.",
        evidence: canonicalProblems.slice(0, 4),
      }),
    );
  }

  // 2. Orphan pages: listed in the sitemap, linked from none of the pages read. It is only answered
  // when the link graph covers the whole sitemap: every listed page was read, or fetched by the
  // bounded sitemap crawl. Without that crawl, only a small sitemap on an uncapped crawl qualifies.
  const locs = s.sitemapXml ? sitemapLocations(s.sitemapXml) : [];
  const capped = s.pages.length >= CRAWL_CAP;
  const host = normalise(s.home.finalUrl)?.split("/")[0];
  const coverage = s.siteCrawl?.coverage ?? null;
  const graphCoversSitemap = s.siteCrawl ? s.siteCrawl.coverage.complete : locs.length <= MAX_SITEMAP_FOR_ORPHANS && !capped;
  const orphanCheck: CrawlInsights["orphanCheck"] = locs.length === 0 ? "no-sitemap" : graphCoversSitemap ? "ran" : "incomplete";
  if (locs.length > 0 && graphCoversSitemap) {
    const linked = new Set<string>();
    for (const res of everything) {
      const $ = cheerio.load(res.body);
      $("a[href]").each((_, el) => {
        const k = normalise($(el).attr("href") ?? "", res.finalUrl);
        if (k) linked.add(k);
      });
    }
    // The homepage and the pages it led to are reached by links by definition. A page the sitemap crawl
    // fetched is only exempt when it answered badly, which is a different problem from being an orphan.
    const readKeys = new Set([
      ...all.flatMap((r) => [normalise(r.finalUrl), normalise(r.url)]),
      ...(s.siteCrawl?.statuses ?? []).filter((x) => x.status !== 200).map((x) => normalise(x.url)),
    ]);
    const orphans = locs.filter((loc) => {
      const k = normalise(loc);
      return k !== null && k.split("/")[0] === host && !linked.has(k) && !readKeys.has(k);
    });
    record("orphan-pages", orphans.length === 0, () =>
      finding("orphan-pages", "low", "medium", {
        title: `${orphans.length} sitemap page${orphans.length === 1 ? " is" : "s are"} not linked from the pages read`,
        detail: s.siteCrawl
          ? "These pages are listed in the sitemap, but none of the sitemap pages links to them. Pages with no internal links get little crawl attention and no link equity."
          : "These pages are listed in the sitemap, but none of the pages SiteRecon read links to them. Pages with no internal links get little crawl attention and no link equity. Pages deeper than the ones read may link to them, so check before acting.",
        fix: "Link to each page from a relevant page (a category, a hub or a related article), or remove it from the sitemap if it should not be indexed.",
        evidence: orphans.slice(0, 5).map((u) => ({ url: u, note: "listed in the sitemap, not linked from the pages read" })),
      }),
    );
  }

  // 3. Internal links that redirect, which waste crawl budget and slow every visit.
  const redirected = [...s.pages, ...extra].filter((p) => normalise(p.url) !== normalise(p.finalUrl));
  if (s.pages.length + extra.length > 0) {
    record("internal-redirects", redirected.length === 0, () =>
      finding("internal-redirects", "low", "low", {
        title: `${redirected.length} internal link${redirected.length === 1 ? "" : "s"} go through a redirect`,
        detail: "Each redirected link costs a request before the real page loads, for visitors and for crawlers.",
        fix: "Update the links to point straight at the final address.",
        evidence: redirected.slice(0, 5).map((p) => ({ url: p.url, note: `redirects to ${clip(p.finalUrl, 120)}` })),
      }),
    );
  }

  // 4. Rendered against raw. Only when the browser step ran and reported structure counts.
  const rendered = s.rendered;
  const $home = cheerio.load(s.home.body);
  const homeHost = new URL(s.home.finalUrl).origin;
  const rawLinks = $home("a[href]").toArray().filter((el) => {
    try {
      return new URL($home(el).attr("href") ?? "", s.home.finalUrl).origin === homeHost;
    } catch {
      return false;
    }
  }).length;
  const rawJsonLd = readJsonLd($home).length;
  const rawH1 = $home("h1").length;
  const diff: CrawlInsights["renderDiff"] = [];

  if (rendered && rendered.links !== undefined) {
    diff.push({ label: "internal links", raw: rawLinks, rendered: rendered.links });
    const missing = rendered.links - rawLinks;
    record("render-links", !(rendered.links >= 8 && rawLinks < rendered.links / 2), () =>
      finding("render-links", "high", "high", {
        title: `The HTML has ${rawLinks} internal links, but a browser sees ${rendered.links}`,
        detail: `${missing} links only appear after JavaScript runs. Crawlers that do not run JavaScript cannot follow them, so the pages behind them may never be found.`,
        fix: "Render navigation and in-content links on the server so they are present in the initial HTML as ordinary <a href> elements.",
        evidence: [{ url: s.home.finalUrl, note: `${rawLinks} internal links in the raw HTML against ${rendered.links} in a real browser` }],
      }),
    );
  }
  if (rendered && rendered.jsonLd !== undefined) {
    diff.push({ label: "JSON-LD blocks", raw: rawJsonLd, rendered: rendered.jsonLd });
    record("render-schema", !(rendered.jsonLd > rawJsonLd), () =>
      finding("render-schema", "medium", "medium", {
        title: `Structured data is added by JavaScript (${rawJsonLd} in the HTML, ${rendered.jsonLd} in a browser)`,
        detail: "Google can read JSON-LD that scripts inject, but most AI crawlers cannot, so they never see it.",
        fix: "Put the JSON-LD in the server-rendered HTML instead of injecting it with a script or a tag manager.",
        evidence: [{ url: s.home.finalUrl, note: `${rawJsonLd} JSON-LD blocks in the raw HTML against ${rendered.jsonLd} in a real browser` }],
      }),
    );
  }
  if (rendered && rendered.h1 !== undefined) {
    diff.push({ label: "H1 headings", raw: rawH1, rendered: rendered.h1 });
    record("render-headings", !(rawH1 === 0 && rendered.h1 > 0), () =>
      finding("render-headings", "high", "high", {
        title: "The main heading only appears after JavaScript runs",
        detail: "The HTML has no H1, but a browser shows one. Bots that do not run JavaScript see a page with no headline, and the page's topic is unclear to them.",
        fix: "Render the page's H1 (and the content under it) on the server.",
        evidence: [{ url: s.home.finalUrl, note: `0 H1 headings in the raw HTML against ${rendered.h1} in a real browser` }],
      }),
    );
  }

  if (rendered && rendered.hydrationErrors !== undefined) {
    const n = rendered.hydrationErrors;
    diff.push({ label: "hydration errors", raw: 0, rendered: n });
    record("render-hydration", n === 0, () =>
      finding("render-hydration", "high", "high", {
        title: `The browser logged ${n} hydration error${n === 1 ? "" : "s"}`,
        detail: "The server-rendered HTML and what the client framework built did not match, so the framework discards the server HTML and rebuilds the page in the browser. Crawlers that do not run JavaScript still see the server version, which may differ from what visitors see.",
        fix: "Find the component that renders differently on the server and the client (dates, random values, window checks, browser-only data) and make both render the same markup.",
        evidence: [{ url: s.home.finalUrl, note: `${n} console message${n === 1 ? "" : "s"} about a hydration mismatch in a real browser` }],
      }),
    );
  }

  const statusClasses = { ok: 0, redirected: 0, clientError: 0, serverError: 0, unreachable: 0 };
  for (const res of all) {
    if (normalise(res.url) !== normalise(res.finalUrl)) statusClasses.redirected += 1;
    else if (res.status >= 500) statusClasses.serverError += 1;
    else if (res.status >= 400) statusClasses.clientError += 1;
    else statusClasses.ok += 1;
  }
  // What the sitemap crawl found, including pages that did not answer at all.
  const movedKeys = new Set(extra.filter((p) => normalise(p.url) !== normalise(p.finalUrl)).map((p) => normalise(p.url)));
  for (const x of s.siteCrawl?.statuses ?? []) {
    if (movedKeys.has(normalise(x.url))) statusClasses.redirected += 1;
    else if (x.status === 0) statusClasses.unreachable += 1;
    else if (x.status >= 500) statusClasses.serverError += 1;
    else if (x.status >= 400) statusClasses.clientError += 1;
    else statusClasses.ok += 1;
  }
  for (const b of s.brokenLinks ?? []) {
    if (b.status >= 500) statusClasses.serverError += 1;
    else statusClasses.clientError += 1;
  }

  return { outcomes, insights: { statusClasses, sitemapUrls: locs.length > 0 ? locs.length : null, coverage, orphanCheck, renderDiff: diff } };
}
