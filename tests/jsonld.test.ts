import { describe, it, expect } from "vitest";
import * as cheerio from "cheerio";
import { readJsonLd, schemaProblems } from "@/lib/checks/jsonld";

const block = (json: string) => `<script type="application/ld+json">${json}</script>`;
const read = (...blocks: string[]) => readJsonLd(cheerio.load(`<html><head>${blocks.join("")}</head><body></body></html>`));

describe("readJsonLd", () => {
  it("returns the parsed data of every valid block", () => {
    const blocks = read(block('{"@type":"Organization","name":"Acme"}'), block('{"@type":"WebSite","name":"Acme"}'));
    expect(blocks).toHaveLength(2);
    expect(blocks.every((b) => b.error === undefined && b.data !== null)).toBe(true);
  });
  it("keeps a broken block, with the reason it did not parse, instead of dropping it", () => {
    const blocks = read(block('{"@type":"Organization",'));
    expect(blocks).toHaveLength(1);
    expect(blocks[0].data).toBeNull();
    expect(blocks[0].error).toMatch(/JSON|Unexpected|end/i);
    expect(blocks[0].raw).toContain("Organization");
  });
  it("returns nothing for a page without structured data", () => {
    expect(read()).toEqual([]);
  });
  it("treats an empty block as broken", () => {
    expect(read(block("   "))[0].error).toBeDefined();
  });
});

const problems = (json: string) => schemaProblems(read(block(json)));

describe("schemaProblems", () => {
  it("finds nothing wrong with complete markup", () => {
    const ok = JSON.stringify({
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "Organization", name: "Acme", url: "https://acme.test/" },
        { "@type": "LocalBusiness", name: "Acme Bakery", address: { "@type": "PostalAddress", streetAddress: "1 High St", addressLocality: "Melbourne" } },
        { "@type": "Article", headline: "How we bake" },
      ],
    });
    expect(problems(ok)).toEqual([]);
  });

  it("flags an organisation with no name", () => {
    const p = problems('{"@type":"Organization","url":"https://acme.test/"}');
    expect(p).toEqual([expect.objectContaining({ kind: "missing", type: "Organization", property: "name" })]);
  });
  it("flags a local business with no address, and counts a plain-text address as present", () => {
    expect(problems('{"@type":"LocalBusiness","name":"Acme"}')).toEqual([expect.objectContaining({ kind: "missing", property: "address" })]);
    expect(problems('{"@type":"LocalBusiness","name":"Acme","address":"1 High St, Melbourne"}')).toEqual([]);
  });
  it("treats a subtype such as Bakery as a local business", () => {
    expect(problems('{"@type":["Bakery","Store"],"name":"Acme"}')).toEqual([expect.objectContaining({ property: "address" })]);
  });
  it("flags a product with no name, an article with no headline and an empty FAQ", () => {
    expect(problems('{"@type":"Product"}')).toEqual([expect.objectContaining({ type: "Product", property: "name" })]);
    expect(problems('{"@type":"BlogPosting"}')).toEqual([expect.objectContaining({ type: "BlogPosting", property: "headline" })]);
    expect(problems('{"@type":"FAQPage","mainEntity":[]}')).toEqual([expect.objectContaining({ type: "FAQPage", property: "mainEntity" })]);
  });
  it("treats an empty or whitespace-only value as missing", () => {
    expect(problems('{"@type":"Organization","name":"   "}')).toEqual([expect.objectContaining({ property: "name" })]);
  });

  it("flags placeholder text left in by a template or a plugin", () => {
    const cases = [
      '{"@type":"Organization","name":"[Business Name]"}',
      '{"@type":"Organization","name":"Lorem ipsum dolor"}',
      '{"@type":"Organization","name":"Acme","description":"Your company description here"}',
      '{"@type":"Organization","name":"Acme","url":"https://yourdomain.com"}',
    ];
    for (const json of cases) {
      const p = problems(json);
      expect(p, json).toEqual([expect.objectContaining({ kind: "placeholder" })]);
      expect(p[0].text!.length).toBeGreaterThan(3);
    }
  });
  it("does not mistake ordinary words for placeholders", () => {
    expect(problems('{"@type":"Organization","name":"Todo Cafe","description":"Our to-do list app"}')).toEqual([]);
  });

  it("looks inside @graph, nested objects and arrays", () => {
    const p = problems('{"@graph":[{"@type":"WebPage","publisher":{"@type":"Organization"}}]}');
    expect(p).toEqual([expect.objectContaining({ type: "Organization", property: "name" })]);
  });
  it("ignores blocks that did not parse (those are reported separately)", () => {
    expect(schemaProblems(read(block("{oops")))).toEqual([]);
  });
  it("stops at a sensible depth rather than looping on hostile input", () => {
    let deep = '{"@type":"Thing"}';
    for (let i = 0; i < 200; i++) deep = `{"x":${deep}}`;
    expect(() => problems(deep)).not.toThrow();
  });
});
