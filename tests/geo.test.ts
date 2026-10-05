import { describe, it, expect } from "vitest";
import { runGeoChecks } from "@/lib/checks/geo";
import { FindingSchema } from "@/lib/pipeline/schemas";
import { snap } from "./helpers/snap";

const PASSAGE = "Acme Storage is an Australian retailer of modular shelving for small homes. " +
  "Every system is cut to size in Melbourne, ships flat packed within five working days, " +
  "and comes with a free design consultation so customers can plan a wardrobe, pantry or garage before they buy anything.";

const GOOD = `<html><head>
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebSite"},{"@type":["Organization","Store"],"name":"Acme"}]}</script>
</head><body><h1>Shelving</h1><p>${PASSAGE}</p><h2>How long does delivery take?</h2><p>${PASSAGE}</p><p>${PASSAGE}</p><p>${PASSAGE}</p></body></html>`;

const failed = (o: ReturnType<typeof runGeoChecks>) => o.filter((x) => !x.passed).map((x) => x.id);

describe("runGeoChecks", () => {
  it("passes a page that is open to AI crawlers and easy to cite", () => {
    const outcomes = runGeoChecks(snap(GOOD, { llmsTxt: "# Acme", robotsTxt: "User-agent: *\nAllow: /" }));
    expect(failed(outcomes)).toEqual([]);
    expect(outcomes.reduce((sum, o) => sum + o.weight, 0)).toBe(100);
  });

  it("reports each AI crawler that robots.txt blocks, quoting the rule's agent", () => {
    const outcomes = runGeoChecks(snap(GOOD, { llmsTxt: "# Acme", robotsTxt: "User-agent: GPTBot\nUser-agent: ClaudeBot\nDisallow: /" }));
    expect(failed(outcomes).sort()).toEqual(["ai-crawler-claudebot", "ai-crawler-gptbot"]);
    const f = outcomes.find((o) => o.id === "ai-crawler-gptbot")!.finding!;
    expect(f.evidence[0].url).toBe("https://example.com/robots.txt");
    expect(f.title).toContain("GPTBot");
  });

  it("treats no robots.txt as open to AI crawlers", () => {
    const ids = failed(runGeoChecks(snap(GOOD, { llmsTxt: "# Acme" })));
    expect(ids.filter((id) => id.startsWith("ai-crawler"))).toEqual([]);
  });

  it("flags a JavaScript-only shell with nothing for an AI crawler to read", () => {
    const shell = `<html><body><div id="root"></div><script>${"var x=1;".repeat(500)}</script><style>.a{}</style></body></html>`;
    const outcomes = runGeoChecks(snap(shell));
    expect(failed(outcomes)).toEqual(expect.arrayContaining([
      "content-in-html", "organisation-schema", "question-headings", "citable-passage", "llms-txt",
    ]));
    for (const o of outcomes.filter((x) => !x.passed)) expect(() => FindingSchema.parse(o.finding)).not.toThrow();
  });

  it("accepts FAQPage schema in place of question headings", () => {
    const html = GOOD.replace("<h2>How long does delivery take?</h2>", "<h2>Delivery</h2>")
      .replace('{"@type":"WebSite"}', '{"@type":"FAQPage"}');
    expect(failed(runGeoChecks(snap(html, { llmsTxt: "x" })))).not.toContain("question-headings");
  });

  it("returns outcomes instead of throwing on broken input", () => {
    expect(runGeoChecks(snap('<script type="application/ld+json">{oops</script><p>')).length).toBe(9);
  });
});
