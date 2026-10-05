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
</head><body><h1>Shelving for small homes</h1><img src="a.png" alt="A shelf"><img src="b.png" alt="A box"></body></html>`;

const goodSnap = () => {
  const s = snap(GOOD, {
    robotsTxt: "User-agent: *\nAllow: /",
    sitemapUrl: "https://example.com/sitemap.xml",
    sitemapXml: "<urlset></urlset>",
  });
  s.home.headers = { "strict-transport-security": "max-age=31536000" };
  return s;
};

const failed = (outcomes: ReturnType<typeof runTechnicalChecks>) => outcomes.filter((o) => !o.passed).map((o) => o.id);

describe("runTechnicalChecks", () => {
  it("passes everything on a well-built page, and the weights total 100", () => {
    const outcomes = runTechnicalChecks(goodSnap());
    expect(failed(outcomes)).toEqual([]);
    expect(outcomes.reduce((sum, o) => sum + o.weight, 0)).toBe(100);
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
    const s = goodSnap();
    s.home.body = html;
    const ids = failed(runTechnicalChecks(s));
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
    expect(outcomes.length).toBe(18);
  });
});
