import { describe, it, expect } from "vitest";
import { collectSnapshot, NotHtmlError, BlockedByRobotsError, TargetUnreachableError, type PageFetcher } from "@/lib/snapshot";
import { page } from "./helpers/snap";

const HOME = `<html><head><title>Shop</title></head><body>
  <nav><a href="/about">About</a><a href="/pricing#top">Pricing</a><a href="/about">About again</a>
  <a href="https://other.com/x">External</a><a href="mailto:a@b.c">Mail</a><a href="/logo.png">Logo</a>
  <a href="/private/area">Private</a><a href="/c">C</a><a href="/d">D</a><a href="/e">E</a><a href="/f">F</a></nav>
</body></html>`;

function site(routes: Record<string, ReturnType<typeof page> | Error>): { fetchPage: PageFetcher; calls: string[] } {
  const calls: string[] = [];
  const fetchPage: PageFetcher = async (url) => {
    calls.push(url);
    const hit = routes[url];
    if (hit instanceof Error) throw hit;
    return hit ?? page(url, "not found", { status: 404 });
  };
  return { fetchPage, calls };
}

const O = "https://example.com";

describe("collectSnapshot", () => {
  it("collects the homepage, robots, sitemap, llms.txt and up to 5 internal pages", async () => {
    const { fetchPage, calls } = site({
      [`${O}/robots.txt`]: page(`${O}/robots.txt`, `User-agent: *\nDisallow: /private\nSitemap: ${O}/map.xml`, { contentType: "text/plain" }),
      [`${O}/`]: page(`${O}/`, HOME),
      [`${O}/map.xml`]: page(`${O}/map.xml`, `<urlset><url><loc>${O}/</loc></url></urlset>`, { contentType: "application/xml" }),
      [`${O}/llms.txt`]: page(`${O}/llms.txt`, "# Shop\n> We sell things", { contentType: "text/plain" }),
      [`${O}/about`]: page(`${O}/about`, "<html>about</html>"),
      [`${O}/pricing`]: page(`${O}/pricing`, "<html>pricing</html>"),
      [`${O}/c`]: page(`${O}/c`, "<html>c</html>"),
      [`${O}/d`]: new Error("socket hang up"),
      [`${O}/e`]: page(`${O}/e`, "<html>e</html>"),
    });

    const { snapshot, couldntCheck } = await collectSnapshot(new URL(`${O}/`), fetchPage);

    expect(snapshot.domain).toBe("example.com");
    expect(snapshot.sitemapUrl).toBe(`${O}/map.xml`);
    expect(snapshot.llmsTxt).toContain("We sell things");
    expect(snapshot.pages.map((p) => p.finalUrl)).toEqual([`${O}/about`, `${O}/pricing`, `${O}/c`, `${O}/e`]);
    expect(calls).not.toContain(`${O}/private/area`);
    expect(calls).not.toContain(`${O}/logo.png`);
    expect(calls).not.toContain("https://other.com/x");
    expect(calls).not.toContain(`${O}/f`); // over the 5-page cap
    expect(couldntCheck).toEqual(expect.arrayContaining([
      expect.objectContaining({ what: `${O}/private/area` }),
      expect.objectContaining({ what: `${O}/d` }),
    ]));
  });

  it("treats a missing robots.txt, sitemap and llms.txt as absent, not as errors", async () => {
    const { fetchPage } = site({ [`${O}/`]: page(`${O}/`, "<html><body>hi</body></html>") });
    const { snapshot } = await collectSnapshot(new URL(`${O}/`), fetchPage);
    expect(snapshot.robotsTxt).toBeNull();
    expect(snapshot.sitemapXml).toBeNull();
    expect(snapshot.llmsTxt).toBeNull();
    expect(snapshot.pages).toEqual([]);
  });

  it("ignores an HTML error page served at /robots.txt", async () => {
    const { fetchPage } = site({
      [`${O}/robots.txt`]: page(`${O}/robots.txt`, "<html>Disallow: /</html>"),
      [`${O}/`]: page(`${O}/`, "<html>hi</html>"),
    });
    const { snapshot } = await collectSnapshot(new URL(`${O}/`), fetchPage);
    expect(snapshot.robotsTxt).toBeNull();
  });

  it("refuses to crawl a site whose robots.txt blocks us", async () => {
    const { fetchPage, calls } = site({
      [`${O}/robots.txt`]: page(`${O}/robots.txt`, "User-agent: *\nDisallow: /", { contentType: "text/plain" }),
      [`${O}/`]: page(`${O}/`, HOME),
    });
    await expect(collectSnapshot(new URL(`${O}/`), fetchPage)).rejects.toBeInstanceOf(BlockedByRobotsError);
    expect(calls).toEqual([`${O}/robots.txt`]);
  });

  it("rejects a target that is not a web page", async () => {
    const { fetchPage } = site({ [`${O}/`]: page(`${O}/`, "%PDF-1.7", { contentType: "application/pdf" }) });
    await expect(collectSnapshot(new URL(`${O}/`), fetchPage)).rejects.toBeInstanceOf(NotHtmlError);
  });

  it("reports an unreachable homepage in plain language", async () => {
    const { fetchPage } = site({ [`${O}/`]: new Error("getaddrinfo ENOTFOUND example.com") });
    await expect(collectSnapshot(new URL(`${O}/`), fetchPage)).rejects.toBeInstanceOf(TargetUnreachableError);
  });

  it("follows a redirect to another host and audits that host", async () => {
    const { fetchPage } = site({
      [`${O}/`]: page(`${O}/`, "<html><a href='/x'>x</a></html>", { finalUrl: "https://www.example.org/" }),
      ["https://www.example.org/x"]: page("https://www.example.org/x", "<html>x</html>"),
    });
    const { snapshot } = await collectSnapshot(new URL(`${O}/`), fetchPage);
    expect(snapshot.origin).toBe("https://www.example.org");
    expect(snapshot.domain).toBe("example.org");
    expect(snapshot.pages.map((p) => p.finalUrl)).toEqual(["https://www.example.org/x"]);
  });
});
