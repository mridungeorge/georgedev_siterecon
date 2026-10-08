import { describe, it, expect } from "vitest";
import { crawlerAccess, runGeoChecks } from "@/lib/checks/geo";
import { FindingSchema } from "@/lib/pipeline/schemas";
import { page, snap } from "./helpers/snap";

const PASSAGE = "Acme Storage is an Australian retailer of modular shelving for small homes. " +
  "Every system is cut to size in Melbourne, ships flat packed within five working days, " +
  "and comes with a free design consultation so customers can plan a wardrobe, pantry or garage before they buy anything.";

const GOOD = `<html><head>
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebSite"},{"@type":["Organization","Store"],"name":"Acme"}]}</script>
</head><body><h1>Shelving</h1><time datetime="2026-09-01">1 September 2026</time><p>${PASSAGE}</p><h2>How long does delivery take?</h2><p>${PASSAGE}</p><p>${PASSAGE}</p><p>${PASSAGE}</p></body></html>`;

const failed = (o: ReturnType<typeof runGeoChecks>) => o.filter((x) => !x.passed).map((x) => x.id);

describe("runGeoChecks", () => {
  it("passes a page that is open to AI crawlers and easy to cite", () => {
    const outcomes = runGeoChecks(snap(GOOD, { llmsTxt: "# Acme", robotsTxt: "User-agent: *\nAllow: /" }));
    expect(failed(outcomes)).toEqual([]);
    expect(outcomes.reduce((sum, o) => sum + o.weight, 0)).toBe(100);
  });

  it("reports each AI search crawler that robots.txt blocks, quoting the rule's agent", () => {
    const outcomes = runGeoChecks(snap(GOOD, { llmsTxt: "# Acme", robotsTxt: "User-agent: OAI-SearchBot\nUser-agent: Claude-SearchBot\nDisallow: /" }));
    expect(failed(outcomes).sort()).toEqual(["ai-crawler-claude-searchbot", "ai-crawler-oai-searchbot"]);
    const f = outcomes.find((o) => o.id === "ai-crawler-oai-searchbot")!.finding!;
    expect(f.evidence[0].url).toBe("https://example.com/robots.txt");
    expect(f.title).toContain("OAI-SearchBot");
    expect(f.detail).toMatch(/ChatGPT/);
  });

  it("flags a blocked PerplexityBot", () => {
    const ids = failed(runGeoChecks(snap(GOOD, { llmsTxt: "x", robotsTxt: "User-agent: PerplexityBot\nDisallow: /" })));
    expect(ids).toEqual(["ai-crawler-perplexitybot"]);
  });

  it("flags a blocked Googlebot and says Google's AI Overviews follow it", () => {
    const outcomes = runGeoChecks(snap(GOOD, { llmsTxt: "x", robotsTxt: "User-agent: Googlebot\nDisallow: /" }));
    expect(failed(outcomes)).toEqual(["ai-crawler-googlebot"]);
    expect(outcomes.find((o) => o.id === "ai-crawler-googlebot")!.finding!.detail).toMatch(/AI Overviews/);
  });

  it("does not penalise blocking the AI training crawlers, which is a legitimate choice", () => {
    const robots = "User-agent: GPTBot\nUser-agent: ClaudeBot\nUser-agent: Google-Extended\nUser-agent: CCBot\nDisallow: /";
    const ids = failed(runGeoChecks(snap(GOOD, { llmsTxt: "# Acme", robotsTxt: robots })));
    expect(ids).toEqual([]);
  });

  it("treats no robots.txt as open to AI crawlers", () => {
    const ids = failed(runGeoChecks(snap(GOOD, { llmsTxt: "# Acme" })));
    expect(ids.filter((id) => id.startsWith("ai-crawler"))).toEqual([]);
  });

  it("flags a JavaScript-only shell with nothing for an AI crawler to read", () => {
    const shell = `<html><body><div id="root"></div><script>${"var x=1;".repeat(500)}</script><style>.a{}</style></body></html>`;
    const outcomes = runGeoChecks(snap(shell));
    expect(failed(outcomes)).toEqual(expect.arrayContaining([
      "content-in-html", "organisation-schema", "question-headings", "citable-passage", "llms-txt", "freshness-signals",
    ]));
    for (const o of outcomes.filter((x) => !x.passed)) expect(() => FindingSchema.parse(o.finding)).not.toThrow();
  });

  it("accepts FAQPage schema in place of question headings", () => {
    const html = GOOD.replace("<h2>How long does delivery take?</h2>", "<h2>Delivery</h2>")
      .replace('{"@type":"WebSite"}', '{"@type":"FAQPage"}');
    expect(failed(runGeoChecks(snap(html, { llmsTxt: "x" })))).not.toContain("question-headings");
  });

  it("returns outcomes instead of throwing on broken input", () => {
    expect(runGeoChecks(snap('<script type="application/ld+json">{oops</script><p>')).length).toBe(10);
  });

  describe("freshness-signals", () => {
    const base = GOOD.replace('<time datetime="2026-09-01">1 September 2026</time>', "");
    const ids = (html: string, headers: Record<string, string> = {}) =>
      failed(runGeoChecks({ ...snap(html, { llmsTxt: "x" }), home: page("https://example.com/", html, { headers }) }));

    it("fails when nothing on the page says when it was written or updated", () => {
      expect(ids(base)).toContain("freshness-signals");
    });
    it("passes with a <time datetime> element", () => {
      expect(ids(GOOD)).not.toContain("freshness-signals");
    });
    it("passes with dateModified in the structured data", () => {
      const html = base.replace('{"@type":"WebSite"}', '{"@type":"WebPage","dateModified":"2026-08-30"}');
      expect(ids(html)).not.toContain("freshness-signals");
    });
    it("passes with an article:modified_time meta tag", () => {
      const html = base.replace("</head>", '<meta property="article:modified_time" content="2026-08-30T10:00:00Z"></head>');
      expect(ids(html)).not.toContain("freshness-signals");
    });
    it("passes with a Last-Modified response header", () => {
      expect(ids(base, { "last-modified": "Tue, 01 Sep 2026 10:00:00 GMT" })).not.toContain("freshness-signals");
    });
    it("ignores a date that is not a real date", () => {
      const html = base.replace("<h1>", '<time datetime="soon">soon</time><h1>');
      expect(ids(html)).toContain("freshness-signals");
    });
  });
});

describe("crawlerAccess (what each AI crawler is allowed to do)", () => {
  const rows = (robotsTxt: string | null) => crawlerAccess(snap(GOOD, { robotsTxt }));
  const row = (robotsTxt: string | null, bot: string) => rows(robotsTxt).find((r) => r.bot === bot)!;

  it("lists search crawlers, the Google crawler and training crawlers, each with what it governs", () => {
    const all = rows(null);
    expect(all.map((r) => r.role)).toEqual(expect.arrayContaining(["search", "google", "training"]));
    for (const r of all) expect(r.governs.length).toBeGreaterThan(10);
    expect(all.map((r) => r.bot)).toEqual(expect.arrayContaining(["OAI-SearchBot", "Claude-SearchBot", "PerplexityBot", "Googlebot", "GPTBot", "ClaudeBot", "Google-Extended", "CCBot"]));
  });
  it("marks every crawler allowed when there is no robots.txt", () => {
    expect(rows(null).every((r) => r.allowed)).toBe(true);
  });
  it("reports a blocked crawler as blocked and the others as allowed", () => {
    const robots = "User-agent: GPTBot\nDisallow: /";
    expect(row(robots, "GPTBot").allowed).toBe(false);
    expect(row(robots, "OAI-SearchBot").allowed).toBe(true);
  });
  it("says GPTBot is for training, not for ChatGPT search, so blocking it is not a visibility problem", () => {
    expect(row(null, "GPTBot").governs).toMatch(/training/i);
    expect(row(null, "OAI-SearchBot").governs).toMatch(/ChatGPT/);
  });
});
