import type { SiteSnapshot, PageFetcher } from "@/lib/snapshot";
import type { SafeResponse } from "@/lib/safe-fetch";
import { USER_AGENT } from "@/lib/safe-fetch";
import { isAllowed } from "@/lib/robots";

// A bounded crawl of the pages the sitemap lists that the snapshot did not read. It exists so that
// "this page is an orphan" and "these are the site's status codes" rest on a link graph that covers
// the whole sitemap, and not on the eleven pages the main crawl reads. It respects robots.txt, stays
// on the site's own host, and stops at a fixed count, saying plainly when it did not cover everything.

const ASSET = /\.(png|jpe?g|gif|webp|svg|ico|css|js|mjs|pdf|zip|gz|mp4|mp3|woff2?|ttf|xml|json|txt)$/i;

export interface CrawlCoverage {
  /** Pages the sitemap lists on the site's own host. */
  sitemapUrls: number;
  /** Pages fetched by this crawl, beyond the ones already read. */
  fetched: number;
  /** True when every listed page was either read before or fetched now. */
  complete: boolean;
}

export interface SitemapCrawl {
  pages: SafeResponse[];
  /** What each fetched address answered, including failures (status 0) and non-HTML files. */
  statuses: { url: string; status: number }[];
  coverage: CrawlCoverage;
}

const key = (raw: string): string | null => {
  try {
    const u = new URL(raw);
    return `${u.hostname.toLowerCase().replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "") || "/"}`;
  } catch {
    return null;
  }
};

export function sitemapLocations(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*([^<\s][^<]*?)\s*<\/loc>/gi)].map((m) => m[1]!);
}

export async function crawlSitemapPages(
  s: SiteSnapshot,
  fetchPage: PageFetcher,
  opts: { limit?: number; concurrency?: number; signal?: AbortSignal } = {},
): Promise<SitemapCrawl> {
  const { limit = 40, concurrency = 4, signal } = opts;
  const empty: SitemapCrawl = { pages: [], statuses: [], coverage: { sitemapUrls: 0, fetched: 0, complete: false } };
  if (!s.sitemapXml) return empty;

  const home = key(s.home.finalUrl)?.split("/")[0];
  const read = new Set([s.home, ...s.pages].flatMap((r) => [key(r.url), key(r.finalUrl)]).filter((k): k is string => k !== null));

  const seen = new Set<string>();
  const onSite: string[] = [];
  for (const loc of sitemapLocations(s.sitemapXml)) {
    let url: URL;
    try {
      url = new URL(loc);
    } catch {
      continue;
    }
    const k = key(loc);
    if (!/^https?:$/.test(url.protocol) || !k || k.split("/")[0] !== home || seen.has(k) || ASSET.test(url.pathname)) continue;
    seen.add(k);
    if (!isAllowed(s.robots, USER_AGENT, url.pathname)) continue; // never crawl what robots.txt forbids
    onSite.push(loc);
  }

  const todo = onSite.filter((loc) => !read.has(key(loc) ?? ""));
  const batch = todo.slice(0, limit);
  const pages: SafeResponse[] = [];
  const statuses: SitemapCrawl["statuses"] = [];

  let next = 0;
  const worker = async () => {
    while (next < batch.length) {
      if (signal?.aborted) throw new Error("The scan was cancelled.");
      const url = batch[next++]!;
      try {
        const res = await fetchPage(url, signal);
        statuses.push({ url, status: res.status });
        if (res.status === 200 && res.contentType.includes("html")) pages.push(res);
      } catch (err) {
        if (signal?.aborted) throw err;
        statuses.push({ url, status: 0 });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, batch.length) }, worker));
  if (signal?.aborted) throw new Error("The scan was cancelled.");

  return {
    pages,
    statuses,
    coverage: { sitemapUrls: onSite.length, fetched: batch.length, complete: todo.length <= limit },
  };
}
