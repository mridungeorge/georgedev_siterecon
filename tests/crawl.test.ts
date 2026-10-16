import { describe, it, expect } from "vitest";
import { runCrawlChecks } from "@/lib/checks/crawl";
import { page, snap } from "./helpers/snap";
import { sitemapLocations } from "@/lib/site-crawl";

const home = (links: string[], extraHead = "") =>
  `<html><head><title>Acme</title>${extraHead}</head><body><h1>Acme</h1>${links.map((l) => `<a href="${l}">${l}</a>`).join("")}</body></html>`;
const sitemap = (...paths: string[]) =>
  `<?xml version="1.0"?><urlset>${paths.map((p) => `<url><loc>https://example.com${p}</loc></url>`).join("")}</urlset>`;
const failed = (r: ReturnType<typeof runCrawlChecks>) => r.outcomes.filter((o) => !o.passed).map((o) => o.id);

describe("canonical consistency", () => {
  it("passes when every page names itself", () => {
    const s = snap(home(["/a"], '<link rel="canonical" href="https://example.com/">'));
    s.pages = [page("https://example.com/a", home([], '<link rel="canonical" href="https://example.com/a">'))];
    expect(failed(runCrawlChecks(s))).not.toContain("canonical-consistency");
  });

  it("flags an inner page whose canonical points at the homepage", () => {
    const s = snap(home(["/a"], '<link rel="canonical" href="https://example.com/">'));
    s.pages = [page("https://example.com/a", home([], '<link rel="canonical" href="https://example.com/">'))];
    const f = runCrawlChecks(s).outcomes.find((o) => o.id === "canonical-consistency")!.finding!;
    expect(f.evidence[0]!.url).toBe("https://example.com/a");
    expect(f.evidence[0]!.note).toMatch(/canonical points to/);
  });

  it("flags a canonical on a different site", () => {
    const s = snap(home(["/a"], '<link rel="canonical" href="https://example.com/">'));
    s.pages = [page("https://example.com/a", home([], '<link rel="canonical" href="https://other.example/a">'))];
    expect(failed(runCrawlChecks(s))).toContain("canonical-consistency");
  });
});

describe("orphan pages", () => {
  it("flags sitemap pages that no page read links to", () => {
    const s = snap(home(["/a"]), { sitemapXml: sitemap("/", "/a", "/hidden") });
    s.pages = [page("https://example.com/a", home([]))];
    const f = runCrawlChecks(s).outcomes.find((o) => o.id === "orphan-pages")!.finding!;
    expect(f.evidence.map((e) => e.url)).toEqual(["https://example.com/hidden"]);
  });

  it("passes when every sitemap page is linked", () => {
    const s = snap(home(["/a"]), { sitemapXml: sitemap("/", "/a") });
    s.pages = [page("https://example.com/a", home([]))];
    expect(runCrawlChecks(s).outcomes.find((o) => o.id === "orphan-pages")?.passed).toBe(true);
  });

  it("says nothing when the crawl was capped, because most pages would look orphaned", () => {
    const paths = Array.from({ length: 12 }, (_, i) => `/p${i}`);
    const s = snap(home(paths), { sitemapXml: sitemap(...paths, "/deep") });
    s.pages = paths.slice(0, 10).map((p) => page(`https://example.com${p}`, home([])));
    expect(runCrawlChecks(s).outcomes.find((o) => o.id === "orphan-pages")).toBeUndefined();
  });

  it("has no opinion without a sitemap", () => {
    expect(runCrawlChecks(snap(home([]))).outcomes.find((o) => o.id === "orphan-pages")).toBeUndefined();
  });
});

describe("internal redirects", () => {
  it("flags an internal link that redirects", () => {
    const s = snap(home(["/old"]));
    s.pages = [page("https://example.com/old", home([]), { finalUrl: "https://example.com/new" })];
    const f = runCrawlChecks(s).outcomes.find((o) => o.id === "internal-redirects")!.finding!;
    expect(f.evidence[0]!.note).toContain("https://example.com/new");
  });
});

describe("rendered against raw", () => {
  const rendered = (over: Record<string, number | boolean>) => ({ words: 400, mobileOverflow: false, h1: 1, links: 20, jsonLd: 1, titleChars: 20, ...over });

  it("has no opinion without a browser render", () => {
    expect(runCrawlChecks(snap(home(["/a"]))).outcomes.filter((o) => o.id.startsWith("render-"))).toEqual([]);
  });

  it("flags navigation that only exists after JavaScript", () => {
    const s = snap(home(["/a"]));
    s.rendered = rendered({ links: 25 });
    expect(failed(runCrawlChecks(s))).toContain("render-links");
  });

  it("flags structured data that only appears after JavaScript", () => {
    const s = snap(home(["/a"]));
    s.rendered = rendered({ links: 1, jsonLd: 2 });
    expect(failed(runCrawlChecks(s))).toContain("render-schema");
  });

  it("flags a headline that only appears after JavaScript", () => {
    const s = snap("<html><head><title>Acme</title></head><body><div id=app></div></body></html>");
    s.rendered = rendered({ links: 0, jsonLd: 0, h1: 1 });
    expect(failed(runCrawlChecks(s))).toContain("render-headings");
  });

  it("flags hydration errors the browser logged", () => {
    const s = snap(home(["/a"]));
    s.rendered = rendered({ links: 1, jsonLd: 0, h1: 1, hydrationErrors: 3 });
    const f = runCrawlChecks(s).outcomes.find((o) => o.id === "render-hydration")!.finding!;
    expect(f.title).toMatch(/3 hydration/);
  });

  it("passes when the browser logged no hydration errors", () => {
    const s = snap(home(["/a"]));
    s.rendered = rendered({ links: 1, jsonLd: 0, h1: 1, hydrationErrors: 0 });
    expect(runCrawlChecks(s).outcomes.find((o) => o.id === "render-hydration")?.passed).toBe(true);
  });

  it("passes when the HTML already contains what the browser shows", () => {
    const s = snap(home(["/a", "/b", "/c"], '<script type="application/ld+json">{"@type":"Organization"}</script>'));
    s.rendered = rendered({ links: 3, jsonLd: 1, h1: 1 });
    expect(failed(runCrawlChecks(s)).filter((id) => id.startsWith("render-"))).toEqual([]);
  });
});

describe("status distribution", () => {
  it("counts the pages read and the broken links by status class", () => {
    const s = snap(home(["/a", "/gone"]));
    s.pages = [page("https://example.com/a", home([]))];
    s.brokenLinks = [{ url: "https://example.com/gone", status: 404 }, { url: "https://example.com/boom", status: 500 }];
    expect(runCrawlChecks(s).insights.statusClasses).toEqual({ ok: 2, redirected: 0, clientError: 1, serverError: 1, unreachable: 0 });
  });
});

describe("determinism", () => {
  it("gives the same result twice", () => {
    const s = snap(home(["/a"]), { sitemapXml: sitemap("/", "/a", "/x") });
    s.pages = [page("https://example.com/a", home([]))];
    expect(runCrawlChecks(s)).toEqual(runCrawlChecks(s));
  });
});

describe("with the sitemap crawl", () => {
  // `urls` is what the sitemap crawl found listed, which is every location in the snapshot's sitemap.
  const crawled = (s: ReturnType<typeof snap>, pages: ReturnType<typeof page>[], statuses: { url: string; status: number }[], complete = true) => ({
    urls: sitemapLocations(s.sitemapXml ?? ""), pages, statuses, coverage: { sitemapUrls: pages.length + 1, fetched: pages.length, complete, childSitemaps: null },
  });

  it("finds an orphan among pages the main crawl never read", () => {
    const s = snap(home(["/a"]), { sitemapXml: sitemap("/", "/a", "/deep", "/island") });
    s.pages = [page("https://example.com/a", home(["/deep"]))];
    const deep = page("https://example.com/deep", home([]));
    const island = page("https://example.com/island", home([]));
    s.siteCrawl = crawled(s, [deep, island], [
      { url: "https://example.com/deep", status: 200 }, { url: "https://example.com/island", status: 200 },
    ]);
    const f = runCrawlChecks(s).outcomes.find((o) => o.id === "orphan-pages")!.finding!;
    expect(f.evidence.map((e) => e.url)).toEqual(["https://example.com/island"]);
  });

  it("does not call a page an orphan when only deeper pages that were fetched link to it", () => {
    const s = snap(home(["/a"]), { sitemapXml: sitemap("/", "/a", "/deep", "/deeper") });
    s.pages = [page("https://example.com/a", home(["/deep"]))];
    s.siteCrawl = crawled(s, 
      [page("https://example.com/deep", home(["/deeper"])), page("https://example.com/deeper", home([]))],
      [{ url: "https://example.com/deep", status: 200 }, { url: "https://example.com/deeper", status: 200 }],
    );
    expect(runCrawlChecks(s).outcomes.find((o) => o.id === "orphan-pages")?.passed).toBe(true);
  });

  it("says the orphan check could not be answered when the sitemap was only partly crawled", () => {
    const s = snap(home(["/a"]), { sitemapXml: sitemap("/", "/a", "/x") });
    s.siteCrawl = crawled(s, [], [], false);
    const r = runCrawlChecks(s);
    expect(r.outcomes.find((o) => o.id === "orphan-pages")).toBeUndefined();
    expect(r.insights.orphanCheck).toBe("incomplete");
    expect(r.insights.coverage).toEqual({ sitemapUrls: 1, fetched: 0, complete: false, childSitemaps: null });
  });

  it("counts the status of every sitemap page fetched, including unreachable ones", () => {
    const s = snap(home([]), { sitemapXml: sitemap("/", "/ok", "/gone", "/error", "/down") });
    s.siteCrawl = crawled(s, [page("https://example.com/ok", home([]))], [
      { url: "https://example.com/ok", status: 200 }, { url: "https://example.com/gone", status: 404 },
      { url: "https://example.com/error", status: 503 }, { url: "https://example.com/down", status: 0 },
    ]);
    expect(runCrawlChecks(s).insights.statusClasses).toEqual({ ok: 2, redirected: 0, clientError: 1, serverError: 1, unreachable: 1 });
  });

  it("checks canonicals on the sitemap pages too", () => {
    const s = snap(home(["/a"], '<link rel="canonical" href="https://example.com/">'));
    s.siteCrawl = crawled(s, 
      [page("https://example.com/deep", home([], '<link rel="canonical" href="https://example.com/">'))],
      [{ url: "https://example.com/deep", status: 200 }],
    );
    expect(failed(runCrawlChecks(s))).toContain("canonical-consistency");
  });
});

describe("finding wording", () => {
  it("agrees the verb with a single page", () => {
    const s = snap(home(["/a"], '<link rel="canonical" href="https://example.com/">'));
    s.pages = [page("https://example.com/a", home([], '<link rel="canonical" href="https://example.com/">'))];
    expect(runCrawlChecks(s).outcomes.find((o) => o.id === "canonical-consistency")!.finding!.title).toBe("1 page declares a canonical that is not the page itself");
  });

  it("says an address redirects, whether it came from a link or the sitemap", () => {
    const s = snap(home(["/old"]));
    s.pages = [page("https://example.com/old", home([]), { finalUrl: "https://example.com/new" })];
    expect(runCrawlChecks(s).outcomes.find((o) => o.id === "internal-redirects")!.finding!.title).toBe("1 address redirects to another page");
  });
});
