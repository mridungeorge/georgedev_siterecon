import { describe, it, expect } from "vitest";
import { generateIdeas } from "@/lib/ideas";
import { LlmUnavailableError, type LlmClient, type LlmCallOptions } from "@/lib/llm/router";
import type { Finding } from "@/lib/pipeline/schemas";

const finding = (id: string): Finding => ({
  id, module: "technical", severity: "high", effort: "low", title: `Title ${id}`, detail: "d", fix: "f",
  evidence: [{ url: "https://example.com/", note: "n" }],
});
const findings = [finding("technical:a"), finding("geo:b")];
const idea = (findingId: string, title: string) => ({ title, why: "because", findingId, effort: "low" });
const reply = (ideas: unknown[]): LlmClient => async () => ({ content: JSON.stringify({ ideas }), provider: "nim", model: "m" });
const input = { url: "https://example.com/", summary: "Acme sells shelving.", findings };

describe("generateIdeas", () => {
  it("keeps ideas that point at a real finding", async () => {
    const r = await generateIdeas(reply([idea("technical:a", "Fix titles"), idea("geo:b", "Add an FAQ")]), input);
    expect(r.ideas.map((i) => i.title)).toEqual(["Fix titles", "Add an FAQ"]);
    expect(r.couldntCheck).toEqual([]);
  });
  it("drops ideas that cite a finding that does not exist, and duplicate titles", async () => {
    const r = await generateIdeas(reply([idea("made:up", "Invented"), idea("geo:b", "Add an FAQ"), idea("technical:a", "add an faq")]), input);
    expect(r.ideas.map((i) => i.title)).toEqual(["Add an FAQ"]);
  });
  it("returns at most 8 ideas", async () => {
    const many = Array.from({ length: 12 }, (_, i) => idea("technical:a", `Idea ${i}`));
    expect((await generateIdeas(reply(many), input)).ideas).toHaveLength(8);
  });
  it("does not call the model when there is nothing to base ideas on", async () => {
    let called = false;
    const llm: LlmClient = async () => { called = true; return { content: "{}", provider: "nim", model: "m" }; };
    const r = await generateIdeas(llm, { ...input, findings: [] });
    expect(called).toBe(false);
    expect(r.ideas).toEqual([]);
  });
  it.each([
    ["no AI provider", null],
    ["providers down", (async () => { throw new LlmUnavailableError("down"); }) as LlmClient],
    ["a non-JSON answer", (async () => ({ content: "sorry", provider: "nim", model: "m" })) as LlmClient],
    ["the wrong shape", reply([{ nope: true }])],
  ])("returns no ideas and a could-not-check note for %s", async (_, llm) => {
    const r = await generateIdeas(llm, input);
    expect(r.ideas).toEqual([]);
    expect(r.couldntCheck[0].what).toMatch(/ideas/i);
  });
  it("fences the site summary as untrusted and asks for JSON", async () => {
    const calls: LlmCallOptions[] = [];
    const llm: LlmClient = async (o) => { calls.push(o); return { content: '{"ideas":[]}', provider: "nim", model: "m" }; };
    await generateIdeas(llm, input);
    expect(calls[0].user).toContain("<<<UNTRUSTED_PAGE_TEXT>>>");
    expect(calls[0].jsonOnly).toBe(true);
  });
});
