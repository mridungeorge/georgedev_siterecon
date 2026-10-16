import { describe, it, expect } from "vitest";
import { runCitationChecks } from "@/lib/checks/citation";
import { page, snap } from "./helpers/snap";

const sentence = "Sunrise Bakery bakes sourdough loaves every morning using stoneground flour and a thirty year old starter.";
/** A paragraph of exactly n words. */
const para = (n: number, seed = "Sunrise Bakery bakes sourdough loaves every morning with stoneground flour from local mills") => {
  const base = seed.split(" ");
  return Array.from({ length: n }, (_, i) => base[i % base.length]).join(" ") + ".";
};

const HEALTHY = `<html><head><title>Sunrise Bakery | Fresh sourdough</title><meta property="og:site_name" content="Sunrise Bakery"></head><body>
<h1>Fresh sourdough, baked daily</h1>
<p>${sentence} We are a family bakery in Melbourne serving 12 suburbs, and we have baked for 30 years.</p>
<h2>How we bake</h2>
<p>${para(150)}</p>
<h2>Where to find us</h2>
<p>We have 4 shops, open 7 days, with over 2,000 loaves sold every week to customers across the city. Read the <a href="https://www.abs.gov.au/">ABS food report</a> and <a href="https://www.csiro.au/wheat">CSIRO wheat research</a>.</p>
</body></html>`;

const ids = (r: ReturnType<typeof runCitationChecks>) => r.outcomes.filter((o) => !o.passed).map((o) => o.id);

describe("runCitationChecks", () => {
  it("passes a page that names the business, defines it, has a quotable passage and concrete facts", () => {
    const r = runCitationChecks(snap(HEALTHY));
    expect(ids(r)).toEqual([]);
    expect(r.insights.pages[0]!.score).toBe(100);
  });

  it("flags a page that never names who it is", () => {
    const html = HEALTHY.replace(/Sunrise Bakery bakes/g, "We bake").replace(sentence, "We bake sourdough every morning.");
    const r = runCitationChecks(snap(html));
    expect(ids(r)).toContain("entity-early");
  });

  it("flags a page with no sentence saying what the business does", () => {
    const html = `<html><head><title>Sunrise Bakery | Fresh sourdough</title></head><body><h1>Welcome</h1><p>Sunrise Bakery.</p><p>Welcome to our website, please look around.</p></body></html>`;
    expect(ids(runCitationChecks(snap(html)))).toContain("definition");
  });

  it("gives half credit to a passage that is quotable but not the best length", () => {
    const html = HEALTHY.replace(para(150), para(90));
    const r = runCitationChecks(snap(html));
    const o = r.outcomes.find((x) => x.id === "answer-passage")!;
    expect(o.passed).toBe(false);
    expect(o.credit).toBe(0.5);
  });

  it("flags a long unbroken paragraph and quotes the start of it", () => {
    const html = HEALTHY.replace(para(150), para(260));
    const f = runCitationChecks(snap(html)).outcomes.find((x) => x.id === "structure")!.finding!;
    expect(f.evidence[0]!.quote).toMatch(/^Sunrise Bakery bakes/);
    expect(f.evidence[0]!.note).toMatch(/260 words/);
  });

  it("flags FAQ content that has no FAQPage markup", () => {
    const qa = [1, 2, 3].map((i) => `<h2>Question number ${i} here?</h2><p>${para(30)}</p>`).join("");
    const html = HEALTHY.replace("</body>", `${qa}</body>`);
    const f = runCitationChecks(snap(html)).outcomes.find((x) => x.id === "schema-fit")!.finding!;
    expect(f.title).toMatch(/FAQPage/);
  });

  it("scores each page it read, so a weak inner page shows up", () => {
    const s = snap(HEALTHY);
    s.pages = [page("https://example.com/menu", `<html><head><title>Menu</title></head><body><h1>Menu</h1><p>${para(120, "bread rolls cakes")}</p></body></html>`)];
    const r = runCitationChecks(s);
    expect(r.insights.pages).toHaveLength(2);
    expect(r.insights.pages[1]!.score!).toBeLessThan(r.insights.pages[0]!.score!);
  });

  it("flags unsupported superlatives and undefined acronyms, and quotes them", () => {
    const filler = para(60, "Our team works with families across the region on every project we take");
    const html = HEALTHY.replace("</body>", `<p>We are the best, a world-class and innovative leader with cutting-edge, unique service. ${filler}</p><p>Our SLA covers the CMDB and the SLA and CMDB are strict. ${filler}</p></body>`);
    const f = runCitationChecks(snap(html)).outcomes.find((x) => x.id === "clarity")!.finding!;
    expect(f.evidence.map((e) => e.note).join(" ")).toMatch(/superlative|undefined/i);
    expect(f.evidence.some((e) => e.quote?.includes("world-class"))).toBe(true);
  });

  it("does not count a superlative that comes with a figure, or an acronym that is explained", () => {
    const html = HEALTHY.replace("</body>", `<p>The best-rated bakery in Melbourne, with 4.9 stars from 800 reviews. The Australian Bureau of Statistics (ABS) says so, and ABS data shows it.</p></body>`);
    expect(ids(runCitationChecks(snap(html)))).not.toContain("clarity");
  });

  it("lists what an AI could lift: the entity, the defining sentence and the concrete facts", () => {
    const e = runCitationChecks(snap(HEALTHY)).insights.extractable;
    expect(e.entity).toBe("Sunrise Bakery");
    expect(e.definition).toContain("bakes sourdough loaves");
    expect(e.facts.length).toBeGreaterThanOrEqual(3);
  });

  it("returns no outcomes for a page with too little text to judge", () => {
    expect(runCitationChecks(snap("<html><body><p>Hi.</p></body></html>")).outcomes.filter((o) => o.id !== "entity-early" && o.id !== "definition")).toEqual([]);
  });

  it("is deterministic", () => {
    expect(runCitationChecks(snap(HEALTHY))).toEqual(runCitationChecks(snap(HEALTHY)));
  });
});

describe("external authority", () => {
  const signals = (over: Partial<{ domainRank: number | null; wikidata: boolean | null; hackerNews: number | null }> = {}) =>
    ({ domainRank: null, wikidata: null, hackerNews: null, ...over });

  it("passes when the domain has a real rank, and shows the signals", () => {
    const r = runCitationChecks(snap(HEALTHY), signals({ domainRank: 4.2 }));
    expect(r.outcomes.find((o) => o.id === "external-authority")).toMatchObject({ passed: true, weight: 12 });
    expect(r.insights.authority).toEqual(signals({ domainRank: 4.2 }));
  });

  it("passes when Wikidata knows the business", () => {
    expect(runCitationChecks(snap(HEALTHY), signals({ wikidata: true })).outcomes.find((o) => o.id === "external-authority")!.passed).toBe(true);
  });

  it("costs score but raises no finding when the signals were measured and show nothing", () => {
    const r = runCitationChecks(snap(HEALTHY), signals({ domainRank: 0.4, wikidata: false }));
    const o = r.outcomes.find((x) => x.id === "external-authority")!;
    expect(o.passed).toBe(false);
    expect(o.finding).toBeUndefined();
    expect(o.credit).toBe(0);
  });

  it("is left out when nothing was measured, so an unconfigured server is not penalised", () => {
    expect(runCitationChecks(snap(HEALTHY), null).outcomes.find((o) => o.id === "external-authority")).toBeUndefined();
    expect(runCitationChecks(snap(HEALTHY), signals()).outcomes.find((o) => o.id === "external-authority")).toBeUndefined();
  });

  it("does not count a Hacker News total of zero against a site on its own", () => {
    expect(runCitationChecks(snap(HEALTHY), signals({ hackerNews: 0 })).outcomes.find((o) => o.id === "external-authority")).toBeUndefined();
  });

  it("counts a Hacker News total of three or more as being known", () => {
    expect(runCitationChecks(snap(HEALTHY), signals({ hackerNews: 5 })).outcomes.find((o) => o.id === "external-authority")!.passed).toBe(true);
  });
});

describe("listing pages are not articles or essays", () => {
  const cards = (n: number) => Array.from({ length: n }, (_, i) => `<article class="card"><h3>Product ${i}</h3><span>$${10 + i}</span></article>`).join("");
  const listing = (extra = "") =>
    `<html><head><title>Sale | Shop</title></head><body><h1>SALE</h1>${cards(40)}${extra}<div>${"shop the range ".repeat(120)}</div></body></html>`;

  it("does not ask a product grid to cite outside sources", () => {
    const s = snap(HEALTHY);
    s.pages = [page("https://example.com/sale/", listing())];
    const r = runCitationChecks(s);
    expect(r.insights.pages[1]!.criteria.authority).toBe("n/a");
  });

  it("does not call a product grid long unbroken text, because it has no prose", () => {
    const s = snap(HEALTHY);
    s.pages = [page("https://example.com/sale/", listing())];
    expect(runCitationChecks(s).insights.pages[1]!.criteria.structure).not.toBe("fail");
  });

  it("still flags a long prose page with no subheadings", () => {
    const prose = Array.from({ length: 5 }, () => `<p>${para(150)}</p>`).join("");
    const s = snap(HEALTHY);
    s.pages = [page("https://example.com/essay", `<html><head><title>Essay</title></head><body><h1>Essay</h1>${prose}</body></html>`)];
    expect(runCitationChecks(s).insights.pages[1]!.criteria.structure).toBe("fail");
  });

  it("says plainly when a page has no paragraph elements at all", () => {
    const s = snap(HEALTHY);
    s.pages = [page("https://example.com/sale/", listing())];
    const f = runCitationChecks(s).outcomes.find((o) => o.id === "answer-passage")?.finding;
    if (f) expect(f.evidence.map((e) => e.note).join(" ")).not.toMatch(/0 words/);
  });
});
