import { describe, it, expect } from "vitest";
import { runTechnicalChecks } from "@/lib/checks/technical";
import { FindingSchema } from "@/lib/pipeline/schemas";
import { snap, page } from "./helpers/snap";

const GOOD = `<!doctype html><html lang="en"><head>
<title>Acme Storage: shelving for small homes</title>
<meta name="description" content="Acme Storage sells modular shelving and storage boxes for small homes, with free design help and delivery across Australia.">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="canonical" href="https://example.com/">
<meta property="og:title" content="Acme Storage"><meta property="og:image" content="https://example.com/og.png">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Acme"}</script>
</head><body><h1>Shelving for small homes</h1><h2>Shop</h2><h3>Boxes</h3>
<a href="/shop">Shop</a><a href="/about">About</a><a href="/contact">Contact</a>
<img src="a.png" alt="A shelf" width="400" height="300"><img src="b.png" alt="A box" width="400" height="300"></body></html>`;

const SECURITY = {
  "strict-transport-security": "max-age=31536000",
  "x-content-type-options": "nosniff",
  "x-frame-options": "SAMEORIGIN",
  "referrer-policy": "strict-origin-when-cross-origin",
};

const goodSnap = () => {
  const s = snap(GOOD, {
    robotsTxt: "User-agent: *\nAllow: /\nSitemap: https://example.com/sitemap.xml",
    sitemapUrl: "https://example.com/sitemap.xml",
    sitemapXml: '<urlset><url><loc>https://example.com/</loc></url><url><loc>https://example.com/shop</loc></url></urlset>',
  });
  s.home.headers = { ...SECURITY };
  return s;
};

const failed = (outcomes: ReturnType<typeof runTechnicalChecks>) => outcomes.filter((o) => !o.passed).map((o) => o.id);
const withBody = (body: string) => {
  const s = goodSnap();
  s.home.body = body;
  return s;
};
const finding = (outcomes: ReturnType<typeof runTechnicalChecks>, id: string) => outcomes.find((o) => o.id === id)!.finding!;

describe("runTechnicalChecks", () => {
  it("passes everything on a well-built page, and the always-on weights total 100", () => {
    const outcomes = runTechnicalChecks(goodSnap());
    expect(failed(outcomes)).toEqual([]);
    // sitemap-quality and robots-sitemap only exist when there is a sitemap and a robots.txt, so they add to the total
    const optional = new Set(["sitemap-quality", "robots-sitemap", "mobile-layout"]);
    expect(outcomes.filter((o) => !optional.has(o.id)).reduce((sum, o) => sum + o.weight, 0)).toBe(100);
    expect(outcomes.map((o) => o.id)).toEqual(expect.arrayContaining(["sitemap-quality", "robots-sitemap"]));
  });

  it("flags each problem on a poor page, with evidence on every finding", () => {
    const BAD = `<html><head><meta name="robots" content="noindex, follow"></head>
      <body><h1>One</h1><h1>Two</h1><img src="a.png"><img src="b.png"></body></html>`;
    const s = snap(BAD);
    s.home = page("http://example.com/", BAD, { status: 500 });
    const outcomes = runTechnicalChecks(s);

    expect(failed(outcomes)).toEqual(expect.arrayContaining([
      "status-ok", "https", "indexable", "title", "meta-description", "single-h1", "canonical",
      "html-lang", "viewport", "image-alt", "robots-txt", "sitemap", "structured-data", "open-graph", "hsts",
      "security-headers", "image-dimensions", "internal-links",
    ]));
    for (const o of outcomes.filter((x) => !x.passed)) {
      expect(() => FindingSchema.parse(o.finding)).not.toThrow();
      expect(o.finding!.id).toBe(`technical:${o.id}`);
    }
    const noindex = outcomes.find((o) => o.id === "indexable")!.finding!;
    expect(noindex.severity).toBe("critical");
    expect(noindex.evidence[0].quote).toContain("noindex");
  });

  it("treats an X-Robots-Tag noindex header as not indexable", () => {
    const s = goodSnap();
    s.home.headers["x-robots-tag"] = "noindex";
    expect(failed(runTechnicalChecks(s))).toContain("indexable");
  });

  it("flags titles and descriptions that are present but the wrong length", () => {
    const html = GOOD.replace(/<title>.*?<\/title>/, "<title>Hi</title>")
      .replace(/content="Acme Storage sells[^"]*"/, 'content="Too short."');
    const ids = failed(runTechnicalChecks(withBody(html)));
    expect(ids).toContain("title-length");
    expect(ids).toContain("meta-description-length");
    expect(ids).not.toContain("title");
    expect(ids).not.toContain("meta-description");
  });

  it("notes when the page was cut at the size cap", () => {
    const s = goodSnap();
    s.home.truncated = true;
    expect(failed(runTechnicalChecks(s))).toContain("not-truncated");
  });

  it.each([
    ["empty", ""],
    ["unclosed tags", "<html><head><title>x<body><h1>y<img src=a"],
    ["binary junk", "\u0000��<<<>>>&&&"],
    ["invalid JSON-LD", '<script type="application/ld+json">{not json</script>'],
  ])("returns outcomes instead of throwing on %s", (_, html) => {
    const outcomes = runTechnicalChecks(snap(html));
    expect(outcomes.length).toBe(26);
  });
});

describe("structured data validation", () => {
  const LD = /<script type="application\/ld\+json">[\s\S]*?<\/script>/;
  const jsonLd = (json: string) => GOOD.replace(LD, `<script type="application/ld+json">${json}</script>`);

  it("flags a broken JSON-LD block, which Google silently ignores, and quotes it", () => {
    const outcomes = runTechnicalChecks(withBody(jsonLd('{"@type":"Organization","name":"Acme",}')));
    expect(failed(outcomes)).toContain("json-ld-valid");
    const f = finding(outcomes, "json-ld-valid");
    expect(f.title).toMatch(/broken/i);
    expect(f.evidence[0].quote).toContain("Organization");
    expect(f.evidence[0].note).toMatch(/block 1/);
  });
  it("does not flag the absence of JSON-LD as a broken block (structured-data covers that)", () => {
    const ids = failed(runTechnicalChecks(withBody(GOOD.replace(LD, ""))));
    expect(ids).toContain("structured-data");
    expect(ids).not.toContain("json-ld-valid");
    expect(ids).not.toContain("schema-complete");
  });
  it("flags a local business with no address", () => {
    const outcomes = runTechnicalChecks(withBody(jsonLd('{"@type":"Bakery","name":"Acme"}')));
    expect(failed(outcomes)).toContain("schema-complete");
    expect(finding(outcomes, "schema-complete").title).toMatch(/address/);
  });
  it("flags placeholder text and quotes it", () => {
    const outcomes = runTechnicalChecks(withBody(jsonLd('{"@type":"Organization","name":"[Business Name]"}')));
    expect(failed(outcomes)).toContain("schema-complete");
    expect(finding(outcomes, "schema-complete").evidence.map((e) => e.quote ?? "").join(" ")).toContain("[Business Name]");
  });
  it("passes complete markup", () => {
    const ids = failed(runTechnicalChecks(withBody(jsonLd('{"@type":"Bakery","name":"Acme","address":"1 High St, Melbourne"}'))));
    expect(ids).not.toContain("schema-complete");
    expect(ids).not.toContain("json-ld-valid");
  });
});

describe("canonical-valid", () => {
  const withCanonical = (href: string) => withBody(GOOD.replace('href="https://example.com/"', `href="${href}"`));
  it("passes a self-referencing canonical, with or without a trailing slash, and a relative one", () => {
    for (const href of ["https://example.com/", "https://example.com", "/"]) {
      expect(failed(runTechnicalChecks(withCanonical(href))), href).not.toContain("canonical-valid");
    }
  });
  it("flags a canonical that points at another page or another site", () => {
    for (const href of ["https://example.com/other", "https://elsewhere.test/"]) {
      const outcomes = runTechnicalChecks(withCanonical(href));
      expect(failed(outcomes), href).toContain("canonical-valid");
      expect(finding(outcomes, "canonical-valid").evidence[0].quote).toContain(href);
    }
  });
  it("flags an http canonical on an https page", () => {
    expect(failed(runTechnicalChecks(withCanonical("http://example.com/")))).toContain("canonical-valid");
  });
  it("leaves a missing canonical to the canonical check", () => {
    const ids = failed(runTechnicalChecks(withBody(GOOD.replace(/<link rel="canonical"[^>]*>/, ""))));
    expect(ids).toContain("canonical");
    expect(ids).not.toContain("canonical-valid");
  });
});

describe("heading-order", () => {
  it("flags a heading that skips a level", () => {
    const outcomes = runTechnicalChecks(withBody(GOOD.replace("<h2>Shop</h2>", "")));
    expect(failed(outcomes)).toContain("heading-order");
    expect(finding(outcomes, "heading-order").title).toMatch(/H1 to H3/);
  });
  it("allows going back up and starting at any level", () => {
    const ok = GOOD.replace("<h1>Shelving for small homes</h1><h2>Shop</h2><h3>Boxes</h3>", "<h2>Intro</h2><h3>A</h3><h2>Next</h2><h1>Title</h1><h2>Z</h2>");
    expect(failed(runTechnicalChecks(withBody(ok)))).not.toContain("heading-order");
  });
});

describe("security-headers", () => {
  const run = (headers: Record<string, string>) => {
    const s = goodSnap();
    s.home.headers = headers;
    return runTechnicalChecks(s);
  };
  it("passes with nosniff, frame protection and a referrer policy", () => {
    expect(failed(run(SECURITY))).not.toContain("security-headers");
  });
  it("accepts a CSP frame-ancestors in place of X-Frame-Options", () => {
    const withoutFrameHeader: Record<string, string> = { ...SECURITY };
    delete withoutFrameHeader["x-frame-options"];
    expect(failed(run({ ...withoutFrameHeader, "content-security-policy": "default-src 'self'; frame-ancestors 'self'" }))).not.toContain("security-headers");
  });
  it("names what is missing", () => {
    const outcomes = run({ "strict-transport-security": "max-age=1" });
    expect(failed(outcomes)).toContain("security-headers");
    const f = finding(outcomes, "security-headers");
    expect(f.detail).toMatch(/X-Content-Type-Options/);
    expect(f.detail).toMatch(/Referrer-Policy/);
    expect(f.detail).toMatch(/X-Frame-Options|frame-ancestors/);
  });
});

describe("image-dimensions", () => {
  it("flags images without width and height, which makes the layout jump as they load", () => {
    const outcomes = runTechnicalChecks(withBody(GOOD.replace(/ width="400" height="300"/g, "")));
    expect(failed(outcomes)).toContain("image-dimensions");
    expect(finding(outcomes, "image-dimensions").title).toMatch(/2 of 2/);
  });
  it("passes when most images have dimensions, or there are none", () => {
    expect(failed(runTechnicalChecks(withBody(GOOD.replace(/<img[^>]*>/g, ""))))).not.toContain("image-dimensions");
  });
  it("ignores inline data images", () => {
    const html = GOOD.replace("</body>", '<img src="data:image/gif;base64,R0lGOD" alt=""></body>');
    expect(failed(runTechnicalChecks(withBody(html)))).not.toContain("image-dimensions");
  });
});

describe("internal-links", () => {
  it("flags a homepage that links to almost nowhere inside the site", () => {
    const outcomes = runTechnicalChecks(withBody(GOOD.replace(/<a href="\/(about|contact)">[^<]*<\/a>/g, "")));
    expect(failed(outcomes)).toContain("internal-links");
    expect(finding(outcomes, "internal-links").title).toMatch(/1 other page/);
  });
  it("says plainly when the homepage links to no other page at all", () => {
    const outcomes = runTechnicalChecks(withBody(GOOD.replace(/<a href="\/(shop|about|contact)">[^<]*<\/a>/g, '<a href="#top">Top</a>')));
    expect(finding(outcomes, "internal-links").title).toBe("The homepage does not link to any other page");
  });
  it("counts distinct pages, not repeated links, and ignores anchors, mailto and external links", () => {
    const html = GOOD.replace(/<a href="\/(about|contact)">[^<]*<\/a>/g, '<a href="/shop">again</a><a href="#top">top</a><a href="mailto:a@b.co">m</a><a href="https://other.test/x">x</a>');
    expect(failed(runTechnicalChecks(withBody(html)))).toContain("internal-links");
  });
});

describe("broken-links", () => {
  it("passes when the pages that were followed all loaded", () => {
    const s = goodSnap();
    s.brokenLinks = [];
    expect(failed(runTechnicalChecks(s))).not.toContain("broken-links");
  });
  it("flags internal links that lead to error pages, naming each one and its status", () => {
    const s = goodSnap();
    s.brokenLinks = [{ url: "https://example.com/old-page", status: 404 }, { url: "https://example.com/api", status: 500 }];
    const outcomes = runTechnicalChecks(s);
    expect(failed(outcomes)).toContain("broken-links");
    const f = finding(outcomes, "broken-links");
    expect(f.severity).toBe("high");
    expect(f.title).toMatch(/2 internal links/);
    expect(f.evidence.map((e) => e.url)).toEqual(["https://example.com/old-page", "https://example.com/api"]);
    expect(f.evidence[0].note).toContain("404");
  });
});

describe("sitemap-quality (only when a sitemap exists)", () => {
  const run = (xml: string | null) => {
    const s = goodSnap();
    s.sitemapXml = xml;
    return runTechnicalChecks(s);
  };
  it("is not scored when there is no sitemap", () => {
    expect(run(null).map((o) => o.id)).not.toContain("sitemap-quality");
  });
  it("passes a clean sitemap, and a sitemap index (whose children are not read)", () => {
    expect(failed(run(goodSnap().sitemapXml))).not.toContain("sitemap-quality");
    expect(failed(run('<sitemapindex><sitemap><loc>https://example.com/s1.xml</loc></sitemap></sitemapindex>'))).not.toContain("sitemap-quality");
  });
  it("flags an empty sitemap", () => {
    expect(failed(run("<urlset></urlset>"))).toContain("sitemap-quality");
  });
  it("flags URLs on another host, http URLs on an https site and duplicates", () => {
    const xml = '<urlset><url><loc>https://example.com/</loc></url><url><loc>https://example.com/</loc></url><url><loc>http://example.com/a</loc></url><url><loc>https://other.test/b</loc></url></urlset>';
    const outcomes = run(xml);
    expect(failed(outcomes)).toContain("sitemap-quality");
    const detail = finding(outcomes, "sitemap-quality").detail;
    expect(detail).toMatch(/another host/);
    expect(detail).toMatch(/http:\/\//);
    expect(detail).toMatch(/duplicate/);
  });
  it("flags a sitemap that leaves out the homepage", () => {
    expect(failed(run("<urlset><url><loc>https://example.com/shop</loc></url></urlset>"))).toContain("sitemap-quality");
  });
});

describe("robots-sitemap (only when robots.txt exists)", () => {
  it("is not scored without a robots.txt", () => {
    const s = goodSnap();
    s.robotsTxt = null;
    s.robots = null;
    expect(runTechnicalChecks(s).map((o) => o.id)).not.toContain("robots-sitemap");
  });
  it("flags a robots.txt that does not say where the sitemap is", () => {
    const s = snap(GOOD, { robotsTxt: "User-agent: *\nAllow: /", sitemapXml: goodSnap().sitemapXml });
    s.home.headers = { ...SECURITY };
    expect(failed(runTechnicalChecks(s))).toContain("robots-sitemap");
  });
  it("passes when a Sitemap line is present", () => {
    expect(failed(runTechnicalChecks(goodSnap()))).not.toContain("robots-sitemap");
  });
});

describe("multi-page checks (only when inner pages were read)", () => {
  const inner = (path: string, title: string, description: string, h1 = "<h1>Heading</h1>", words = 200) =>
    page(`https://example.com${path}`, `<html><head><title>${title}</title><meta name="description" content="${description}"></head><body>${h1}<p>${"word ".repeat(words)}</p></body></html>`);
  const run = (...pages: ReturnType<typeof inner>[]) => {
    const s = goodSnap();
    s.pages = pages;
    return runTechnicalChecks(s);
  };
  const GOOD_PAGE = inner("/shop", "Shop shelving online", "Browse every shelf and storage box we sell, with free delivery on orders over one hundred dollars.");

  it("is not scored when only the homepage was read", () => {
    const ids = runTechnicalChecks(goodSnap()).map((o) => o.id);
    for (const id of ["pages-titles", "pages-descriptions", "pages-h1", "pages-content"]) expect(ids).not.toContain(id);
  });
  it("passes healthy inner pages", () => {
    expect(failed(run(GOOD_PAGE))).toEqual([]);
  });
  it("flags an inner page with no title, and a title shared with another page", () => {
    expect(failed(run(inner("/shop", "", "A description long enough to count here, about shelving.")))).toContain("pages-titles");
    const dup = inner("/about", "Acme Storage: shelving for small homes", "About us and how we started making shelving for small homes.");
    const outcomes = run(GOOD_PAGE, dup);
    expect(failed(outcomes)).toContain("pages-titles");
    expect(finding(outcomes, "pages-titles").evidence.map((e) => e.url)).toEqual(expect.arrayContaining(["https://example.com/about"]));
  });
  it("flags missing and repeated meta descriptions on inner pages", () => {
    expect(failed(run(inner("/shop", "Shop", "")))).toContain("pages-descriptions");
    const a = inner("/a", "Page A here", "The same words used on two pages of the site, which search engines treat as templated.");
    const b = inner("/b", "Page B here", "The same words used on two pages of the site, which search engines treat as templated.");
    expect(failed(run(a, b))).toContain("pages-descriptions");
  });
  it("flags inner pages with no H1 or more than one", () => {
    expect(failed(run(inner("/shop", "Shop", "A long enough description of this shop page for the check.", "")))).toContain("pages-h1");
    expect(failed(run(inner("/shop", "Shop", "A long enough description of this shop page for the check.", "<h1>A</h1><h1>B</h1>")))).toContain("pages-h1");
  });
  it("flags thin inner pages", () => {
    const outcomes = run(inner("/shop", "Shop shelving", "A long enough description of this shop page for the check.", "<h1>Shop</h1>", 20));
    expect(failed(outcomes)).toContain("pages-content");
    expect(finding(outcomes, "pages-content").evidence[0].note).toMatch(/words/);
  });
  it("keeps the weights of the always-on checks at 100 whether or not inner pages were read", () => {
    const always = (outs: ReturnType<typeof runTechnicalChecks>) => outs.filter((o) => !/^(pages-|sitemap-quality|robots-sitemap|mobile-layout)/.test(o.id)).reduce((s, o) => s + o.weight, 0);
    expect(always(run(GOOD_PAGE))).toBe(100);
    expect(always(runTechnicalChecks(goodSnap()))).toBe(100);
  });
});

describe("probe checks (only when the probe could be made)", () => {
  const run = (probes?: NonNullable<ReturnType<typeof goodSnap>["probes"]>) => {
    const s = goodSnap();
    if (probes) s.probes = probes;
    return runTechnicalChecks(s);
  };
  const ids = (outcomes: ReturnType<typeof runTechnicalChecks>) => outcomes.map((o) => o.id);

  it("scores none of them when probing was off or every probe failed", () => {
    for (const out of [run(), run({ http: null, alternateHost: null, notFound: null })]) {
      for (const id of ["https-redirect", "host-redirect", "soft-404"]) expect(ids(out)).not.toContain(id);
    }
  });

  describe("https-redirect", () => {
    it("passes when http:// ends up on https", () => {
      expect(failed(run({ http: { finalUrl: "https://example.com/", status: 200 } }))).not.toContain("https-redirect");
    });
    it("flags an http:// address that stays on http, naming it", () => {
      const outcomes = run({ http: { finalUrl: "http://example.com/", status: 200 } });
      expect(failed(outcomes)).toContain("https-redirect");
      expect(finding(outcomes, "https-redirect").evidence[0].note).toMatch(/http:\/\/example\.com\//);
    });
  });

  describe("host-redirect", () => {
    it("passes when the other spelling redirects to the main address", () => {
      expect(failed(run({ alternateHost: { url: "https://www.example.com/", finalUrl: "https://example.com/", status: 200 } }))).not.toContain("host-redirect");
    });
    it("flags both spellings serving the site, which splits its ranking between two addresses", () => {
      const outcomes = run({ alternateHost: { url: "https://www.example.com/", finalUrl: "https://www.example.com/", status: 200 } });
      expect(failed(outcomes)).toContain("host-redirect");
      expect(finding(outcomes, "host-redirect").title).toMatch(/www/);
    });
  });

  describe("soft-404", () => {
    it.each([404, 410])("passes when a missing page returns %i", (status) => {
      expect(failed(run({ notFound: { status } }))).not.toContain("soft-404");
    });
    it("flags a missing page that returns 200, which fills search results with empty pages", () => {
      const outcomes = run({ notFound: { status: 200 } });
      expect(failed(outcomes)).toContain("soft-404");
      expect(finding(outcomes, "soft-404").severity).toBe("medium");
    });
    it.each([401, 403, 429, 500, 503])("does not judge a site that answers %i, because that says nothing about its 404 page", (status) => {
      expect(ids(run({ notFound: { status } }))).not.toContain("soft-404");
    });
  });
});

describe("hreflang (only when the page declares alternate languages)", () => {
  const withLinks = (links: string) => {
    const s = goodSnap();
    s.home.body = GOOD.replace("</head>", `${links}</head>`);
    return runTechnicalChecks(s);
  };
  const SELF = '<link rel="alternate" hreflang="en" href="https://example.com/">';
  const FR = '<link rel="alternate" hreflang="fr-CA" href="https://example.com/fr/">';

  it("is not scored on a page with no hreflang links", () => {
    expect(runTechnicalChecks(goodSnap()).map((o) => o.id)).not.toContain("hreflang-valid");
  });
  it("passes a complete set that includes the page itself, with x-default", () => {
    const outcomes = withLinks(`${SELF}${FR}<link rel="alternate" hreflang="x-default" href="https://example.com/">`);
    expect(outcomes.map((o) => o.id)).toContain("hreflang-valid");
    expect(failed(outcomes)).not.toContain("hreflang-valid");
  });
  it("flags a set that leaves out the page itself, which search engines ignore", () => {
    const outcomes = withLinks(FR);
    expect(failed(outcomes)).toContain("hreflang-valid");
    expect(finding(outcomes, "hreflang-valid").detail).toMatch(/itself/);
  });
  it("flags relative addresses and invalid language codes", () => {
    const outcomes = withLinks(`${SELF}<link rel="alternate" hreflang="english" href="https://example.com/en/"><link rel="alternate" hreflang="de" href="/de/">`);
    expect(failed(outcomes)).toContain("hreflang-valid");
    const detail = finding(outcomes, "hreflang-valid").detail;
    expect(detail).toMatch(/english/);
    expect(detail).toMatch(/\/de\//);
  });
});

describe("article-authorship (only on pages that declare an article)", () => {
  const withSchema = (json: string) => {
    const s = goodSnap();
    s.home.body = GOOD.replace("</head>", `<script type="application/ld+json">${json}</script></head>`);
    return runTechnicalChecks(s);
  };
  it("is not scored when no page declares an article", () => {
    expect(runTechnicalChecks(goodSnap()).map((o) => o.id)).not.toContain("article-authorship");
  });
  it("passes an article with an author and a publish date", () => {
    const outcomes = withSchema('{"@type":"BlogPosting","headline":"H","author":{"@type":"Person","name":"Ada"},"datePublished":"2026-01-02"}');
    expect(outcomes.map((o) => o.id)).toContain("article-authorship");
    expect(failed(outcomes)).not.toContain("article-authorship");
  });
  it("flags an article with no author or no date, naming what is missing", () => {
    const outcomes = withSchema('{"@type":"Article","headline":"H"}');
    expect(failed(outcomes)).toContain("article-authorship");
    expect(finding(outcomes, "article-authorship").detail).toMatch(/author.*date|date.*author/i);
  });
  it("treats an empty author name as missing", () => {
    expect(failed(withSchema('{"@type":"NewsArticle","headline":"H","author":{"name":"  "},"datePublished":"2026-01-02"}'))).toContain("article-authorship");
  });
});
