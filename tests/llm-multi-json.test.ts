import { describe, it, expect } from "vitest";
import { extractAllJson, mergeLists } from "@/lib/llm/router";
import { generateIdeas } from "@/lib/ideas";
import { runContentChecks } from "@/lib/checks/content";
import { findCompetitors } from "@/lib/competitors";
import type { Finding } from "@/lib/pipeline/schemas";
import type { LlmCallOptions, LlmClient } from "@/lib/llm/router";
import { page, snap } from "./helpers/snap";

// Found by running the real model: instead of {"ideas":[a,b,c]} it sometimes answers
// {"ideas":[a]} {"ideas":[b]} {"ideas":[c]}, one object per item, back to back. Reading only the first
// threw away most of the answer without any error.

describe("extractAllJson", () => {
  it("returns a single object as one value", () => {
    expect(extractAllJson('{"a":1}')).toEqual([{ a: 1 }]);
  });
  it("returns every object when several follow each other, with or without separators", () => {
    expect(extractAllJson('{"a":1} {"a":2}\n{"a":3}{"a":4}')).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }, { a: 4 }]);
  });
  it("reads objects inside code fences and between sentences", () => {
    expect(extractAllJson('Here: ```json\n{"a":1}\n``` and also {"a":2}. Done.')).toEqual([{ a: 1 }, { a: 2 }]);
  });
  it("returns only top-level values, not the ones nested inside them", () => {
    expect(extractAllJson('{"a":{"b":1},"c":[{"d":2}]}')).toEqual([{ a: { b: 1 }, c: [{ d: 2 }] }]);
  });
  it("is not fooled by braces and quotes inside strings", () => {
    expect(extractAllJson('{"a":"} {\\"x\\"}"} {"b":2}')).toEqual([{ a: '} {"x"}' }, { b: 2 }]);
  });
  it("skips a broken fragment and still returns the valid values after it", () => {
    expect(extractAllJson('{"a":1} {oops {"b":2}')).toEqual([{ a: 1 }, { b: 2 }]);
  });
  it("returns top-level arrays too", () => {
    expect(extractAllJson('[1,2] {"x":1}')).toEqual([[1, 2], { x: 1 }]);
  });
  it("stops at a maximum number of values", () => {
    expect(extractAllJson("{}".repeat(100), 5)).toHaveLength(5);
  });
  it("throws when there is no JSON at all", () => {
    expect(() => extractAllJson("I cannot help with that.")).toThrow(/no JSON/i);
  });
  it("throws when the only JSON is cut off", () => {
    expect(() => extractAllJson('{"ideas":[{"title":"x"')).toThrow(/incomplete|no JSON/i);
  });
  it("does not take long on adversarial input", () => {
    const started = Date.now();
    try { extractAllJson("{".repeat(20_000)); } catch { /* expected */ }
    expect(Date.now() - started).toBeLessThan(1500);
  });
});

describe("mergeLists", () => {
  it("joins the lists found under a key in every object that has one", () => {
    expect(mergeLists([{ ideas: [1, 2] }, { other: 1 }, { ideas: [3] }, "text", null, { ideas: "no" }], "ideas")).toEqual([1, 2, 3]);
  });
  it("is empty when no object has the key", () => {
    expect(mergeLists([{ a: [1] }], "ideas")).toEqual([]);
  });
});

const reply = (content: string): LlmClient => async () => ({ content, provider: "nim", model: "m" });
const one = (key: string, item: unknown) => JSON.stringify({ [key]: [item] });

describe("the modules read an answer split into several objects", () => {
  it("marketing ideas: collects the ideas from every object", async () => {
    const findings: Finding[] = ["a", "b", "c"].map((id) => ({
      id: `technical:${id}`, module: "technical", severity: "low", effort: "low", title: id, detail: "d", fix: "f", evidence: [{ url: "https://example.com/", note: "n" }],
    }));
    const content = findings.map((f) => one("ideas", { title: `Fix ${f.title} on the homepage`, why: "It helps", findingId: f.id, effort: "low" })).join(" ");
    const r = await generateIdeas(reply(content), { url: "https://example.com/", summary: "s", findings });
    expect(r.ideas.map((i) => i.findingId)).toEqual(["technical:a", "technical:b", "technical:c"]);
  });

  it("content review: counts all four answers without asking again", async () => {
    const PLAIN = "<p>We make shelves. They fit small rooms. You pick a size and a colour. We build it and send it to your door. Most orders arrive in five days. If it does not fit, we take it back.</p>";
    const html = `<html lang="en"><head><title>Acme Storage</title></head><body><nav><a href="/shop">Shop</a><a href="/about">About</a><a href="/contact">Contact</a></nav><h1>Modular shelving made for small homes</h1>${PLAIN.repeat(8)}<a href="/quote">Get a free quote</a><a href="tel:+61300000000">Call us</a></body></html>`;
    const calls: LlmCallOptions[] = [];
    const llm: LlmClient = async (o) => {
      calls.push(o);
      const content = ["value-prop", "audience", "cta-clarity", "differentiation"]
        .map((id) => one("items", { id, passed: true, quote: "We make shelves. They fit small rooms." })).join(" ");
      return { content, provider: "nim", model: "m" };
    };
    const r = await runContentChecks(snap(html), llm);
    expect(calls).toHaveLength(1);
    expect(r.outcomes.filter((o) => ["value-prop", "audience", "cta-clarity", "differentiation"].includes(o.id))).toHaveLength(4);
  });

  it("competitors: collects the domains from every object", async () => {
    const GOOD = `<html lang="en"><head><title>Rival shelving for homes everywhere</title></head><body><h1>Storage for every home</h1></body></html>`;
    const fetchPage = async (url: string) => (new URL(url).pathname === "/" ? page(url, GOOD) : page(url, "nope", { status: 404 }));
    const content = [one("competitors", { domain: "a.example" }), one("competitors", { domain: "b.example" })].join(" ");
    const r = await findCompetitors({ domain: "acme.example", title: "Acme", description: "", summary: "s", technical: 50, geo: 50, platforms: [] }, { llm: reply(content), search: null, fetchPage });
    expect(r.table!.rows.map((x) => x.domain)).toEqual(["a.example", "b.example"]);
  });
});
