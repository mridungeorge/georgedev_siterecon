import { describe, it, expect } from "vitest";
import { runContentChecks } from "@/lib/checks/content";
import type { LlmCallOptions, LlmClient } from "@/lib/llm/router";
import { snap } from "./helpers/snap";

// Lessons from running the content review against a real model on a real site: the model answers
// only some of the questions, quotes button text that is only a few words long, and drops or adds a
// comma when it copies a sentence. None of that may loosen the evidence rule, which is that an AI
// answer only counts when it quotes the same words, in the same order, from one place on the page.

const HTML = `<html lang="en"><head><title>George — AI engineer</title>
<meta name="description" content="I design, build and deploy AI applications end to end: agent pipelines, retrieval, evaluation and the infrastructure that keeps them running.">
</head><body><nav><a href="/a">A</a><a href="/b">B</a><a href="/c">C</a></nav>
<h1>I build AI products that ship to real users.</h1>
<p>I’m looking for a founding or forward-deployed AI engineering role at a startup that wants someone who ships.</p>
<a href="/work">See the work</a><a href="mailto:a@b.co">Email</a><p>Rated 5 stars by 200 customers.</p></body></html>`;

type Item = { id: string; passed: boolean; quote?: string; severity?: string };
const IDS = ["value-prop", "audience", "cta-clarity", "differentiation"];
const full = (over: Record<string, Partial<Item>> = {}): Item[] =>
  IDS.map((id) => ({ id, passed: true, quote: "I build AI products that ship to real users.", ...over[id] }));
const llmOf = (...answers: Item[][]): { llm: LlmClient; calls: LlmCallOptions[] } => {
  const calls: LlmCallOptions[] = [];
  const llm: LlmClient = async (o) => {
    calls.push(o);
    const items = answers[Math.min(calls.length - 1, answers.length - 1)];
    return { content: JSON.stringify({ items }), provider: "nim", model: "m" };
  };
  return { llm, calls };
};
const counted = (r: Awaited<ReturnType<typeof runContentChecks>>) => r.outcomes.filter((o) => IDS.includes(o.id)).map((o) => `${o.id}:${o.passed ? "pass" : "fail"}`);

describe("quote matching ignores punctuation and typography, not words or their order", () => {
  it("accepts a straight apostrophe where the page has a curly one", async () => {
    const { llm } = llmOf(full({ audience: { quote: "I'm looking for a founding or forward-deployed AI engineering role" } }));
    expect(counted(await runContentChecks(snap(HTML), llm))).toContain("audience:pass");
  });
  it("accepts a quote where the model added or dropped a comma", async () => {
    const { llm } = llmOf(full({ value_prop: {}, "value-prop": { quote: "I design, build and deploy AI applications end to end: agent pipelines, retrieval, evaluation, and the infrastructure that keeps them running." } }));
    expect(counted(await runContentChecks(snap(HTML), llm))).toContain("value-prop:pass");
  });
  it("accepts different capitalisation and spacing", async () => {
    const { llm } = llmOf(full({ audience: { quote: "  I’M   LOOKING for a FOUNDING or forward deployed ai engineering role " } }));
    expect(counted(await runContentChecks(snap(HTML), llm))).toContain("audience:pass");
  });
  it("still rejects the same words in a different order", async () => {
    const { llm } = llmOf(full({ audience: { quote: "ships who someone wants startup a at role engineering" } }));
    expect(counted(await runContentChecks(snap(HTML), llm))).not.toContain("audience:pass");
  });
  it("still rejects a quote that adds a word that is not on the page", async () => {
    const { llm } = llmOf(full({ audience: { quote: "I am really looking for a founding or forward-deployed AI engineering role" } }));
    expect(counted(await runContentChecks(snap(HTML), llm))).not.toContain("audience:pass");
  });
});

describe("short quotes", () => {
  it("accepts a three-word quote that is really on the page, such as button text", async () => {
    const { llm } = llmOf(full({ "cta-clarity": { passed: false, quote: "See the work", severity: "medium" } }));
    const r = await runContentChecks(snap(HTML), llm);
    expect(counted(r)).toContain("cta-clarity:fail");
    expect(r.outcomes.find((o) => o.id === "cta-clarity")!.finding!.evidence[0].quote).toBe("See the work");
  });
  it.each(["Email", "See the", "5 stars", "ok"])("still rejects the too-short quote %j", async (quote) => {
    const { llm } = llmOf(full({ "cta-clarity": { passed: false, quote } }));
    expect(counted(await runContentChecks(snap(HTML), llm))).not.toContain("cta-clarity:fail");
  });
});

describe("a model that answers only some of the questions", () => {
  it("is asked once more, and the second answer is used", async () => {
    const { llm, calls } = llmOf([full()[0]], full());
    const r = await runContentChecks(snap(HTML), llm);
    expect(calls).toHaveLength(2);
    expect(counted(r)).toHaveLength(4);
    expect(calls[1].user).toMatch(/audience|cta-clarity|differentiation/);
    expect(calls[1].user).toMatch(/all four/i);
  });
  it("is never asked a third time, and the missing answers are reported as could not check", async () => {
    const { llm, calls } = llmOf([full()[0]]);
    const r = await runContentChecks(snap(HTML), llm);
    expect(calls).toHaveLength(2);
    expect(counted(r)).toEqual(["value-prop:pass"]);
    expect(r.couldntCheck.filter((c) => /did not answer/.test(c.why))).toHaveLength(3);
  });
  it("is asked only once when the first answer is complete", async () => {
    const { llm, calls } = llmOf(full());
    await runContentChecks(snap(HTML), llm);
    expect(calls).toHaveLength(1);
  });
  it("keeps the answers from the first try that it did get, if the retry fails", async () => {
    const calls: LlmCallOptions[] = [];
    const llm: LlmClient = async (o) => {
      calls.push(o);
      if (calls.length === 1) return { content: JSON.stringify({ items: [full()[0]] }), provider: "nim", model: "m" };
      throw new Error("provider down");
    };
    const r = await runContentChecks(snap(HTML), llm);
    expect(counted(r)).toEqual(["value-prop:pass"]);
  });
});
