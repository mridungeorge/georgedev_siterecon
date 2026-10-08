import * as cheerio from "cheerio";
import { USER_AGENT, type SafeResponse } from "./safe-fetch";
import { isAllowed, parseRobots, type RobotsRules } from "./robots";
import { targetDomain } from "./url-guard";
import type { CouldntCheck } from "./pipeline/schemas";

export type PageFetcher = (url: string, signal?: AbortSignal) => Promise<SafeResponse>;

export interface SiteSnapshot {
  origin: string;
  domain: string;
  home: SafeResponse;
  pages: SafeResponse[];
  robotsTxt: string | null;
  robots: RobotsRules | null;
  sitemapUrl: string | null;
  sitemapXml: string | null;
  llmsTxt: string | null;
  fetchedAt: string;
  /** Internal links that were followed and led to an error page. */
  brokenLinks?: { url: string; status: number }[];
  /** What a real browser saw, when the optional render step ran. */
  rendered?: { words: number; mobileOverflow: boolean };
}

export class TargetUnreachableError extends Error {}
export class NotHtmlError extends Error {}
export class BlockedByRobotsError extends Error {}

/** Inner pages read per scan, and how many are fetched at once. Each fetch may take up to 15 s. */
const MAX_INNER_PAGES = 10;
const PAGE_CONCURRENCY = 4;

const ASSET = /\.(png|jpe?g|gif|webp|svg|ico|css|js|mjs|pdf|zip|gz|mp4|mp3|woff2?|ttf|xml|json|txt)$/i;

/** Fetches a plain-text file. Missing files and HTML error pages both count as absent. */
async function fetchText(url: string, fetchPage: PageFetcher): Promise<string | null> {
  try {
    const res = await fetchPage(url);
    if (res.status !== 200 || res.contentType.includes("html") || /^\s*</.test(res.body)) return null;
    return res.body;
  } catch {
    return null;
  }
}

async function loadRobots(origin: string, fetchPage: PageFetcher): Promise<{ txt: string | null; rules: RobotsRules | null }> {
  const txt = await fetchText(`${origin}/robots.txt`, fetchPage);
  return { txt, rules: txt === null ? null : parseRobots(txt) };
}

function internalLinks(html: string, base: string, origin: string): string[] {
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const basePath = new URL(base).pathname;
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    let url: URL;
    try {
      url = new URL(href, base);
    } catch {
      return;
    }
    if (url.origin !== origin || ASSET.test(url.pathname)) return;
    url.hash = "";
    url.search = "";
    if (url.pathname === basePath) return;
    seen.add(url.toString());
  });
  return [...seen];
}

/**
 * Crawls the homepage and up to ten internal pages. Respects robots.txt: a disallowed homepage
 * stops the scan before the page is requested, and disallowed inner pages are skipped.
 */
export async function collectSnapshot(
  target: URL,
  fetchPage: PageFetcher,
  maxPages = MAX_INNER_PAGES,
): Promise<{ snapshot: SiteSnapshot; couldntCheck: CouldntCheck[] }> {
  const couldntCheck: CouldntCheck[] = [];
  const blocked = (host: string) =>
    new BlockedByRobotsError(`${host} asks crawlers not to visit this page (robots.txt), so SiteRecon did not scan it.`);

  let robots = await loadRobots(target.origin, fetchPage);
  if (!isAllowed(robots.rules, USER_AGENT, target.pathname)) throw blocked(target.hostname);

  let home: SafeResponse;
  try {
    home = await fetchPage(target.toString());
  } catch (err) {
    throw new TargetUnreachableError(
      `Couldn't reach ${target.hostname}. Check the address is right and the site is online. (${(err as Error).message})`,
    );
  }
  // A bot challenge or an outage page is not the site. Auditing it would score the error
  // page, and the report would be cached as if it were the real thing. SiteRecon does not
  // try to get around bot protection, so a block is reported as one.
  if (home.status === 401 || home.status === 403 || home.status === 429) {
    throw new TargetUnreachableError(
      `${target.hostname} blocks automated access (HTTP ${home.status}), so SiteRecon could not scan it. SiteRecon does not try to get around bot protection.`,
    );
  }
  if (home.status >= 400) {
    throw new TargetUnreachableError(
      `${target.hostname} returned an error (HTTP ${home.status}) instead of its homepage. Try again once the site is working.`,
    );
  }
  if (!home.contentType.includes("html")) {
    throw new NotHtmlError(`${target.toString()} is not a web page (it returned "${home.contentType || "an unknown type"}").`);
  }

  // The site may redirect to another host (apex to www, or a new domain). Audit where it lands.
  const finalUrl = new URL(home.finalUrl);
  if (finalUrl.origin !== target.origin) {
    robots = await loadRobots(finalUrl.origin, fetchPage);
    if (!isAllowed(robots.rules, USER_AGENT, finalUrl.pathname)) throw blocked(finalUrl.hostname);
  }
  const origin = finalUrl.origin;

  const sitemapUrl = robots.rules?.sitemaps[0] ?? `${origin}/sitemap.xml`;
  let sitemapXml: string | null = null;
  try {
    const res = await fetchPage(sitemapUrl);
    if (res.status === 200 && /<(urlset|sitemapindex)[\s>]/i.test(res.body)) sitemapXml = res.body;
  } catch {
    // an unreachable sitemap is the same as no sitemap
  }

  const llmsTxt = await fetchText(`${origin}/llms.txt`, fetchPage);

  // Pick the pages to read first (robots.txt decides), then fetch them a few at a time. Results are
  // handled in link order so the same site always gives the same report.
  const candidates: string[] = [];
  for (const link of internalLinks(home.body, home.finalUrl, origin)) {
    if (candidates.length >= maxPages) break;
    if (!isAllowed(robots.rules, USER_AGENT, new URL(link).pathname)) {
      couldntCheck.push({ what: link, why: "robots.txt asks crawlers not to visit this page" });
      continue;
    }
    candidates.push(link);
  }

  type Fetched = { link: string; res: SafeResponse } | { link: string; error: string };
  const results: Fetched[] = new Array(candidates.length);
  let next = 0;
  const worker = async () => {
    while (next < candidates.length) {
      const i = next++;
      const link = candidates[i];
      try {
        results[i] = { link, res: await fetchPage(link) };
      } catch (err) {
        results[i] = { link, error: (err as Error).message };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PAGE_CONCURRENCY, candidates.length) }, worker));

  const pages: SafeResponse[] = [];
  const brokenLinks: { url: string; status: number }[] = [];
  for (const r of results) {
    if ("error" in r) couldntCheck.push({ what: r.link, why: `could not be fetched (${r.error})` });
    else if (r.res.status >= 400) brokenLinks.push({ url: r.link, status: r.res.status });
    else if (r.res.status === 200 && r.res.contentType.includes("html")) pages.push(r.res);
    else couldntCheck.push({ what: r.link, why: r.res.status === 200 ? "is not a web page" : `returned HTTP ${r.res.status}` });
  }

  return {
    snapshot: {
      origin,
      domain: targetDomain(finalUrl),
      home,
      pages,
      robotsTxt: robots.txt,
      robots: robots.rules,
      sitemapUrl: sitemapXml ? sitemapUrl : null,
      sitemapXml,
      llmsTxt,
      fetchedAt: new Date().toISOString(),
      brokenLinks,
    },
    couldntCheck,
  };
}
