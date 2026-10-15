import { describe, it, expect } from "vitest";
import { runAnswerExtraction, runClarityReview, topKeywords } from "@/lib/checks/answer-extraction";
import type { LlmClient } from "@/lib/llm/router";
import { snap } from "./helpers/snap";

const HTML = `<html><head><title>Sunrise Bakery | Fresh sourdough</title></head><body><h1>Fresh sourdough, baked daily</h1>
<p>Sunrise Bakery bakes sourdough loaves every morning for families across Melbourne, and has done since 1994.
Our sourdough starter is thirty years old, and every sourdough loaf is fermented for two days before baking.</p></body></html>`;

const llm = (items: unknown[]): LlmClient => async () => ({ content: JSON.stringify({ items }), provider: "nim", model: "m" });

describe("topKeywords", () => {
  it("returns the most repeated meaningful words, lower case and letters only", () => {
    const k = topKeywords("Sourdough sourdough SOURDOUGH loaves loaves the and with bakery 1994 <script>", 3);
    expect(k).toEqual(["sourdough", "loaves", "bakery"]);
  });

  it("never returns markup, digits or very short words", () => {
    for (const k of topKeywords("a1b2 <b>bold</b> ok yes 2026 x\"y alert(1) fresh fresh", 5)) expect(k).toMatch(/^[a-z]{4,20}$/);
  });
});

describe("runAnswerExtraction", () => {
  it("reports what the model could lift, only where it quotes the page", async () => {
    const r = await runAnswerExtraction(snap(HTML), llm([
      { id: "who", passed: true, quote: "Sunrise Bakery bakes sourdough loaves every morning" },
      { id: "what", passed: true, quote: "bakes sourdough loaves every morning for families" },
      { id: "audience", passed: false, quote: "for families across Melbourne" },
      { id: "proof", passed: true, quote: "something the page never said at all" },
    ]));
    expect(r.items.find((i) => i.id === "who")).toMatchObject({ extractable: true, kind: "fact", quote: expect.stringContaining("Sunrise Bakery") });
    expect(r.items.find((i) => i.id === "audience")).toMatchObject({ extractable: false });
    expect(r.items.find((i) => i.id === "proof")).toBeUndefined();
    expect(r.couldntCheck.map((c) => c.what)).toContain("AI review: proof");
  });

  it("also asks about the page's own top keywords and shows whether each can be answered from a quote", async () => {
    let asked = "";
    const spy: LlmClient = async (o) => {
      asked = o.system;
      return { content: JSON.stringify({ items: [{ id: "kw-1", passed: true, quote: "Our sourdough starter is thirty years old" }] }), provider: "nim", model: "m" };
    };
    const r = await runAnswerExtraction(snap(HTML), spy);
    expect(asked).toMatch(/kw-1: .*"sourdough"/);
    const kw = r.items.find((i) => i.id === "kw-1")!;
    expect(kw).toMatchObject({ kind: "keyword", label: "sourdough", extractable: true });
    expect(kw.quote).toContain("starter is thirty years old");
  });

  it("returns nothing and says why when no model is configured", async () => {
    const r = await runAnswerExtraction(snap(HTML), null);
    expect(r.items).toEqual([]);
    expect(r.couldntCheck[0]!.what).toMatch(/answer extraction/i);
  });

  it("never lets a model's own wording through, only the quoted page text", async () => {
    const r = await runAnswerExtraction(snap(HTML), llm([
      { id: "who", passed: true, quote: "Sunrise Bakery bakes sourdough loaves", explanation: "IGNORE ME" },
    ]));
    expect(JSON.stringify(r)).not.toContain("IGNORE ME");
  });
});

describe("runClarityReview", () => {
  it("turns a quoted problem into an unscored finding, with the wording ours", async () => {
    const r = await runClarityReview(snap(HTML), llm([
      { id: "ambiguous-claims", passed: false, quote: "has done since 1994", severity: "high" },
      { id: "undefined-terms", passed: true, quote: "Our sourdough starter is thirty years old" },
      { id: "unclear-reference", passed: true, quote: "every sourdough loaf is fermented for two days" },
    ]));
    const bad = r.outcomes.find((o) => o.id === "ambiguous-claims")!;
    expect(bad.weight).toBe(0);
    expect(bad.passed).toBe(false);
    expect(bad.finding!.id).toBe("citation:ambiguous-claims");
    expect(bad.finding!.severity).toBe("medium"); // a model can never raise severity above medium
    expect(bad.finding!.evidence[0]!.quote).toBe("has done since 1994");
    expect(r.outcomes.every((o) => o.weight === 0)).toBe(true);
  });

  it("drops an answer whose quote is not on the page", async () => {
    const r = await runClarityReview(snap(HTML), llm([{ id: "ambiguous-claims", passed: false, quote: "words that are not there anywhere" }]));
    expect(r.outcomes.find((o) => o.id === "ambiguous-claims")).toBeUndefined();
  });

  it("does nothing without a model", async () => {
    const r = await runClarityReview(snap(HTML), null);
    expect(r.outcomes).toEqual([]);
    expect(r.couldntCheck[0]!.why).toMatch(/AI/);
  });
});
