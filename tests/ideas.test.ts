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

import { pickIdeaFindings } from "@/lib/ideas";
import type { ModuleName, ModuleResult, Severity } from "@/lib/pipeline/schemas";

describe("pickIdeaFindings (which findings the ideas are built from)", () => {
  const f = (module: ModuleName, n: number, severity: Severity = "medium"): Finding => ({
    id: `${module}:c${n}`, module, severity, effort: "low", title: `${module} ${n}`, detail: "d", fix: "f", evidence: [{ url: "https://example.com/", note: "n" }],
  });
  const mod = (module: ModuleName, findings: Finding[]): ModuleResult => ({ module, status: "ok", score: 50, findings, passed: [], couldntCheck: [] });
  const range = (module: ModuleName, count: number) => Array.from({ length: count }, (_, i) => f(module, i));

  it("starts with the marketing findings, then content and social, and only then SEO and speed", () => {
    const picked = pickIdeaFindings([mod("technical", range("technical", 3)), mod("performance", range("performance", 2)), mod("marketing", range("marketing", 2)), mod("social", range("social", 1)), mod("content", range("content", 1))]);
    expect(picked.map((x) => x.module)).toEqual(["marketing", "marketing", "content", "social", "technical", "technical", "technical", "performance", "performance"]);
  });

  it("never lets one module take more than five places, so the ideas stay varied", () => {
    const picked = pickIdeaFindings([mod("marketing", range("marketing", 9)), mod("technical", range("technical", 9))]);
    expect(picked.filter((x) => x.module === "marketing")).toHaveLength(5);
    expect(picked.filter((x) => x.module === "technical")).toHaveLength(5);
    expect(picked).toHaveLength(10);
  });

  it("never returns more than twelve, however many findings there are", () => {
    const picked = pickIdeaFindings([mod("marketing", range("marketing", 9)), mod("technical", [f("technical", 0, "low"), ...range("technical", 3).slice(1).map((x) => ({ ...x, severity: "critical" as Severity }))])]);
    expect(picked.length).toBeLessThanOrEqual(12);
    expect(picked.filter((x) => x.module === "marketing").length).toBeGreaterThanOrEqual(5);
  });

  it("puts the most severe findings of a module first", () => {
    const picked = pickIdeaFindings([mod("marketing", [f("marketing", 0, "low"), f("marketing", 1, "critical"), f("marketing", 2, "high")])]);
    expect(picked.map((x) => x.severity)).toEqual(["critical", "high", "low"]);
  });

  it("is empty when there are no findings, and deterministic", () => {
    expect(pickIdeaFindings([mod("marketing", [])])).toEqual([]);
    const m = [mod("marketing", range("marketing", 3)), mod("technical", range("technical", 2))];
    expect(pickIdeaFindings(m)).toEqual(pickIdeaFindings(m));
  });
});

describe("generateIdeas retry", () => {
  const good = JSON.stringify({ ideas: [{ title: "Fix titles", why: "w", findingId: "technical:a", effort: "low" }] });
  it("asks again once when the first answer cannot be read, so one cut-off reply does not lose the ideas", async () => {
    let calls = 0;
    const llm: LlmClient = async () => ({ content: calls++ === 0 ? '{"ideas":[{"title":"Fix ti' : good, provider: "nim", model: "m" });
    const r = await generateIdeas(llm, input);
    expect(calls).toBe(2);
    expect(r.ideas.map((i) => i.title)).toEqual(["Fix titles"]);
  });
  it("does not retry when the providers are down", async () => {
    let calls = 0;
    const llm: LlmClient = async () => { calls++; throw new LlmUnavailableError("down"); };
    await generateIdeas(llm, input);
    expect(calls).toBe(1);
  });
  it("gives up after the second unreadable answer", async () => {
    let calls = 0;
    const llm: LlmClient = async () => { calls++; return { content: "sorry", provider: "nim", model: "m" }; };
    const r = await generateIdeas(llm, input);
    expect(calls).toBe(2);
    expect(r.couldntCheck[0].what).toBe("Marketing ideas");
  });
});
