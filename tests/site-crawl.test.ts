import { describe, it, expect } from "vitest";
import { crawlSitemapPages, sitemapLocations } from "@/lib/site-crawl";
import { page, snap } from "./helpers/snap";
import type { SafeResponse } from "@/lib/safe-fetch";

const sitemap = (...paths: string[]) =>
  `<?xml version="1.0"?><urlset>${paths.map((p) => `<url><loc>${p.startsWith("http") ? p : `https://example.com${p}`}</loc></url>`).join("")}</urlset>`;
const html = (links: string[] = []) => `<html><head><title>t</title></head><body>${links.map((l) => `<a href="${l}">x</a>`).join("")}</body></html>`;

function fetcher(pages: Record<string, Partial<SafeResponse> & { body?: string }>) {
  const calls: string[] = [];
  const fn = async (url: string): Promise<SafeResponse> => {
    calls.push(url);
    const p = pages[url];
    if (!p) return { ...page(url, "nope"), status: 404 };
    if ((p as { throws?: boolean }).throws) throw new Error("boom");
    return { ...page(url, p.body ?? html()), ...p };
  };
  return { fn, calls };
}

describe("crawlSitemapPages", () => {
  it("fetches sitemap pages that were not read yet, and reports full coverage", async () => {
    const s = snap(html(["/a"]), { sitemapXml: sitemap("/", "/a", "/b", "/c") });
    s.pages = [page("https://example.com/a", html())];
    const f = fetcher({ "https://example.com/b": {}, "https://example.com/c": {} });
    const r = await crawlSitemapPages(s, f.fn);
    expect(f.calls.sort()).toEqual(["https://example.com/b", "https://example.com/c"]);
    expect(r.pages.map((p) => p.finalUrl).sort()).toEqual(["https://example.com/b", "https://example.com/c"]);
    expect(r.coverage).toEqual({ sitemapUrls: 4, fetched: 2, complete: true, childSitemaps: null });
  });

  it("stops at the limit and says the crawl is incomplete", async () => {
    const paths = Array.from({ length: 12 }, (_, i) => `/p${i}`);
    const s = snap(html(), { sitemapXml: sitemap(...paths) });
    const f = fetcher(Object.fromEntries(paths.map((p) => [`https://example.com${p}`, {}])));
    const r = await crawlSitemapPages(s, f.fn, { limit: 5 });
    expect(r.pages).toHaveLength(5);
    expect(r.coverage.complete).toBe(false);
    expect(r.coverage.sitemapUrls).toBe(12);
  });

  it("ignores other hosts, assets, and pages robots.txt disallows", async () => {
    const s = snap(html(), {
      sitemapXml: sitemap("/ok", "https://elsewhere.test/x", "/photo.jpg", "/private/doc"),
      robotsTxt: "User-agent: *\nDisallow: /private/\n",
    });
    const f = fetcher({ "https://example.com/ok": {} });
    const r = await crawlSitemapPages(s, f.fn);
    expect(f.calls).toEqual(["https://example.com/ok"]);
    expect(r.coverage.complete).toBe(true);
  });

  it("keeps failed and non-HTML answers as status records instead of dropping them", async () => {
    const s = snap(html(), { sitemapXml: sitemap("/gone", "/file", "/down") });
    const f = fetcher({
      "https://example.com/file": { contentType: "application/pdf", body: "%PDF" },
      "https://example.com/down": { throws: true } as never,
    });
    const r = await crawlSitemapPages(s, f.fn);
    expect(r.statuses.find((x) => x.url.endsWith("/gone"))!.status).toBe(404);
    expect(r.statuses.find((x) => x.url.endsWith("/down"))!.status).toBe(0);
    expect(r.pages.map((p) => p.finalUrl)).not.toContain("https://example.com/file");
  });

  it("does nothing without a sitemap", async () => {
    const f = fetcher({});
    const r = await crawlSitemapPages(snap(html()), f.fn);
    expect(f.calls).toEqual([]);
    expect(r.coverage).toEqual({ sitemapUrls: 0, fetched: 0, complete: false, childSitemaps: null });
  });

  it("stops when the scan is cancelled", async () => {
    const controller = new AbortController();
    const s = snap(html(), { sitemapXml: sitemap("/a", "/b", "/c", "/d", "/e", "/f") });
    const f = fetcher(Object.fromEntries(["a", "b", "c", "d", "e", "f"].map((p) => [`https://example.com/${p}`, {}])));
    const fn = async (url: string) => { controller.abort(); return f.fn(url); };
    await expect(crawlSitemapPages(s, fn, { signal: controller.signal, concurrency: 1 })).rejects.toThrow(/cancel/i);
  });
});

describe("sitemap indexes", () => {
  const index = (...children: string[]) =>
    `<?xml version="1.0"?><sitemapindex>${children.map((c) => `<sitemap><loc>https://example.com${c}</loc></sitemap>`).join("")}</sitemapindex>`;

  it("follows the child sitemaps of an index and crawls the pages they list", async () => {
    const s = snap(html(["/a"]), { sitemapXml: index("/sitemap-pages.xml", "/sitemap-products.xml") });
    const f = fetcher({
      "https://example.com/sitemap-pages.xml": { body: sitemap("/", "/about"), contentType: "application/xml" },
      "https://example.com/sitemap-products.xml": { body: sitemap("/p1"), contentType: "application/xml" },
      "https://example.com/about": {}, "https://example.com/p1": {},
    });
    const r = await crawlSitemapPages(s, f.fn);
    expect(f.calls.sort()).toEqual([
      "https://example.com/about", "https://example.com/p1", "https://example.com/sitemap-pages.xml", "https://example.com/sitemap-products.xml",
    ]);
    expect(r.pages.map((p) => p.finalUrl).sort()).toEqual(["https://example.com/about", "https://example.com/p1"]);
    expect(r.coverage.complete).toBe(true);
  });

  it("says the crawl is incomplete when the index has more child sitemaps than it will read", async () => {
    const kids = Array.from({ length: 8 }, (_, i) => `/s${i}.xml`);
    const s = snap(html(), { sitemapXml: index(...kids) });
    const f = fetcher(Object.fromEntries(kids.map((k) => [`https://example.com${k}`, { body: sitemap("/x"), contentType: "application/xml" }])));
    const r = await crawlSitemapPages(s, f.fn, { maxChildSitemaps: 3 });
    expect(f.calls.filter((c) => c.endsWith(".xml"))).toHaveLength(3);
    expect(r.coverage.complete).toBe(false);
  });

  it("does not read a child sitemap on another host", async () => {
    const s = snap(html(), { sitemapXml: `<sitemapindex><sitemap><loc>https://elsewhere.test/s.xml</loc></sitemap></sitemapindex>` });
    const f = fetcher({});
    await crawlSitemapPages(s, f.fn);
    expect(f.calls).toEqual([]);
  });

  it("counts a child sitemap that cannot be read as an incomplete crawl", async () => {
    const s = snap(html(), { sitemapXml: index("/broken.xml") });
    const f = fetcher({});
    const r = await crawlSitemapPages(s, f.fn);
    expect(r.coverage.complete).toBe(false);
  });
});

describe("XML in sitemaps", () => {
  it("decodes &amp; and the other XML entities in a location before it is fetched", () => {
    const xml = `<urlset><url><loc>https://example.com/p.php?type=pages&amp;page=1</loc></url><url><loc>https://example.com/a?x=1&lt;2&gt;&quot;q&quot;&apos;s&apos;</loc></url></urlset>`;
    expect(sitemapLocations(xml)).toEqual(["https://example.com/p.php?type=pages&page=1", "https://example.com/a?x=1<2>\"q\"'s'"]);
  });

  it("reads a location wrapped in CDATA", () => {
    expect(sitemapLocations("<urlset><url><loc><![CDATA[https://example.com/a?b=1&c=2]]></loc></url></urlset>")).toEqual(["https://example.com/a?b=1&c=2"]);
  });

  it("asks for a child sitemap with a real ampersand, as a BigCommerce store needs", async () => {
    const s = snap(html(), {
      sitemapXml: `<sitemapindex><sitemap><loc>https://example.com/xmlsitemap.php?type=pages&amp;page=1</loc></sitemap></sitemapindex>`,
    });
    const f = fetcher({
      "https://example.com/xmlsitemap.php?type=pages&page=1": { body: sitemap("/", "/about"), contentType: "application/xml" },
      "https://example.com/about": {},
    });
    const r = await crawlSitemapPages(s, f.fn);
    expect(f.calls[0]).toBe("https://example.com/xmlsitemap.php?type=pages&page=1");
    expect(r.pages.map((p) => p.finalUrl)).toEqual(["https://example.com/about"]);
    expect(r.coverage.childSitemaps).toEqual({ listed: 1, read: 1 });
  });

  it("keeps two pages that differ only in their query string apart", async () => {
    const s = snap(html(), { sitemapXml: sitemap("/item.php?id=1", "/item.php?id=2") });
    const f = fetcher({ "https://example.com/item.php?id=1": {}, "https://example.com/item.php?id=2": {} });
    const r = await crawlSitemapPages(s, f.fn);
    expect(r.pages).toHaveLength(2);
  });

  it("reports how many child sitemaps it could read", async () => {
    const s = snap(html(), { sitemapXml: `<sitemapindex><sitemap><loc>https://example.com/a.xml</loc></sitemap><sitemap><loc>https://example.com/b.xml</loc></sitemap></sitemapindex>` });
    const f = fetcher({ "https://example.com/a.xml": { body: sitemap("/x"), contentType: "application/xml" }, "https://example.com/x": {} });
    const r = await crawlSitemapPages(s, f.fn);
    expect(r.coverage.childSitemaps).toEqual({ listed: 2, read: 1 });
    expect(r.coverage.complete).toBe(false);
  });
});
