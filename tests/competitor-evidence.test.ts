import { describe, it, expect } from "vitest";
import { computeGaps } from "@/lib/competitors";
import type { CompetitorRow } from "@/lib/pipeline/schemas";

const row = (domain: string, over: Partial<CompetitorRow> = {}): CompetitorRow => ({
  domain, url: `https://${domain}/`, source: "ai", technical: 70, geo: 70, platforms: [], title: "", headline: "", description: "",
  passed: [], schemaTypes: [], words: 300, topics: [], entities: [], sitemapUrls: 0, ...over,
});
const site = { technical: 70, geo: 70, platforms: [], schemaTypes: [] as string[], words: 300, topics: [] as string[], entities: [] as string[], sitemapUrls: 0 };

describe("competitor evidence", () => {
  it("names the competitors that publish a schema type the site lacks, and says exactly what to add", () => {
    const gaps = computeGaps({ ...site, schemaTypes: ["Organization"] }, [row("a.example", { schemaTypes: ["Organization", "FAQPage"] }), row("b.example", { schemaTypes: ["FAQPage"] }), row("c.example")]);
    const line = gaps.find((g) => g.includes("FAQPage"))!;
    expect(line).toMatch(/a\.example, b\.example/);
    expect(line).toMatch(/mainEntity/);
    expect(line).toMatch(/you do not/i);
  });

  it("says nothing about a schema type the site already has", () => {
    const gaps = computeGaps({ ...site, schemaTypes: ["FAQPage"] }, [row("a.example", { schemaTypes: ["FAQPage"] })]);
    expect(gaps.join(" ")).not.toContain("FAQPage");
  });

  it("ignores a schema type only a minority of competitors use", () => {
    const gaps = computeGaps(site, [row("a.example", { schemaTypes: ["Product"] }), row("b.example"), row("c.example")]);
    expect(gaps.join(" ")).not.toContain("Product");
  });

  it("reports content depth when competitors write at least half as much again", () => {
    const gaps = computeGaps({ ...site, words: 200 }, [row("a.example", { words: 500 }), row("b.example", { words: 450 })]);
    expect(gaps.some((g) => /median of 475 words against your 200/.test(g))).toBe(true);
  });

  it("does not report content depth when the site is comparable", () => {
    const gaps = computeGaps({ ...site, words: 300 }, [row("a.example", { words: 320 })]);
    expect(gaps.join(" ")).not.toMatch(/median of/);
  });

  it("lists the topics most competitors cover in their headings that the site does not", () => {
    const gaps = computeGaps({ ...site, topics: ["shelving"] }, [
      row("a.example", { topics: ["shelving", "pantry", "labels"] }),
      row("b.example", { topics: ["pantry", "labels", "baskets"] }),
    ]);
    const line = gaps.find((g) => /headings/i.test(g))!;
    expect(line).toContain("pantry");
    expect(line).toContain("labels");
    expect(line).not.toContain("shelving");
    expect(line).not.toContain("baskets");
  });

  it("still returns the no-gaps line when there is nothing to report", () => {
    expect(computeGaps(site, [row("a.example")])).toEqual(["No clear gaps against these competitors."]);
  });
});

describe("entities and sitemap size", () => {
  it("names the entities most competitors mention that the site does not", () => {
    const gaps = computeGaps({ ...site, entities: ["sunrise bakery", "melbourne"] }, [
      row("a.example", { entities: ["melbourne", "stoneground flour", "sourdough society"] }),
      row("b.example", { entities: ["stoneground flour", "sourdough society"] }),
    ]);
    const line = gaps.find((g) => /repeatedly name these entities/i.test(g))!;
    expect(line).toContain("stoneground flour");
    expect(line).toContain("sourdough society");
    expect(line).not.toContain("melbourne");
  });

  it("reports how many of the site's entities competitors also name", () => {
    const gaps = computeGaps({ ...site, entities: ["melbourne", "sunrise bakery"] }, [row("a.example", { entities: ["melbourne"] })]);
    expect(gaps.join(" ")).toMatch(/1 of 2 of the places, brands and names you mention also appear/);
  });

  it("compares how many pages competitors list in their sitemaps", () => {
    const gaps = computeGaps({ ...site, sitemapUrls: 20 }, [row("a.example", { sitemapUrls: 90 }), row("b.example", { sitemapUrls: 70 })]);
    expect(gaps.some((g) => /median of 80 pages in their sitemaps against your 20/.test(g))).toBe(true);
  });

  it("says nothing about size when the site is comparable or has no sitemap", () => {
    expect(computeGaps({ ...site, sitemapUrls: 70 }, [row("a.example", { sitemapUrls: 90 })]).join(" ")).not.toMatch(/sitemaps/);
    expect(computeGaps({ ...site, sitemapUrls: 0 }, [row("a.example", { sitemapUrls: 90 })]).join(" ")).not.toMatch(/sitemaps/);
  });
});
