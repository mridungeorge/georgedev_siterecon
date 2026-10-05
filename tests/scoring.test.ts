import { describe, it, expect } from "vitest";
import { buildModuleResult, failedModule, overallScore, topFixes } from "@/lib/scoring";
import { buildFixPrompt } from "@/lib/fix-prompt";
import type { CheckOutcome, Finding } from "@/lib/pipeline/schemas";

const finding = (id: string, severity: Finding["severity"], effort: Finding["effort"]): Finding => ({
  id: `technical:${id}`, module: "technical", severity, effort, title: `Title ${id}`, detail: `Detail ${id}`,
  fix: `Fix ${id}`, evidence: [{ url: "https://example.com/", quote: `quote ${id}` }],
});
const pass = (id: string, weight: number): CheckOutcome => ({ id, weight, passed: true });
const fail = (id: string, weight: number, f: Finding): CheckOutcome => ({ id, weight, passed: false, finding: f });

describe("buildModuleResult", () => {
  it("scores by the weight of passed checks", () => {
    const r = buildModuleResult("technical", [pass("a", 30), pass("b", 45), fail("c", 25, finding("c", "high", "low"))]);
    expect(r.score).toBe(75);
    expect(r.status).toBe("ok");
    expect(r.passed).toEqual(["a", "b"]);
    expect(r.findings.map((f) => f.id)).toEqual(["technical:c"]);
  });
  it("is partial when something could not be checked", () => {
    const r = buildModuleResult("technical", [pass("a", 10)], [{ what: "x", why: "y" }]);
    expect(r.status).toBe("partial");
    expect(r.score).toBe(100);
  });
  it("has no score when there were no checks", () => {
    expect(buildModuleResult("technical", []).score).toBeNull();
  });
});

describe("failedModule", () => {
  it("records why and has no score", () => {
    const r = failedModule("geo", "boom");
    expect(r).toMatchObject({ module: "geo", status: "failed", score: null, findings: [] });
    expect(r.couldntCheck).toEqual([{ what: "geo", why: "boom" }]);
  });
});

describe("overallScore", () => {
  it("is the weighted mean of the modules that have a score", () => {
    const technical = buildModuleResult("technical", [pass("a", 80), fail("b", 20, finding("b", "low", "low"))]); // 80, weight 30
    const geo = buildModuleResult("geo", [pass("a", 50), fail("b", 50, finding("b", "low", "low"))]); // 50, weight 20
    expect(overallScore([technical, geo])).toBe(68); // (80*30 + 50*20) / 50
    expect(overallScore([technical, failedModule("geo", "x")])).toBe(80);
    expect(overallScore([failedModule("geo", "x")])).toBeNull();
  });
});

describe("topFixes", () => {
  it("orders by severity, then by least effort, and respects the limit", () => {
    const r = buildModuleResult("technical", [
      fail("low-easy", 1, finding("low-easy", "low", "low")),
      fail("crit-hard", 1, finding("crit-hard", "critical", "high")),
      fail("high-easy", 1, finding("high-easy", "high", "low")),
      fail("high-hard", 1, finding("high-hard", "high", "high")),
      fail("crit-easy", 1, finding("crit-easy", "critical", "low")),
    ]);
    expect(topFixes([r]).map((f) => f.id)).toEqual([
      "technical:crit-easy", "technical:crit-hard", "technical:high-easy", "technical:high-hard", "technical:low-easy",
    ]);
    expect(topFixes([r], 2)).toHaveLength(2);
  });
});

describe("buildFixPrompt", () => {
  it("lists every finding with its evidence and fix", () => {
    const prompt = buildFixPrompt({ url: "https://example.com/", findings: [finding("a", "critical", "low"), finding("b", "low", "high")] });
    expect(prompt).toContain("https://example.com/");
    expect(prompt).toContain("1. [CRITICAL] Title a");
    expect(prompt).toContain("2. [LOW] Title b");
    expect(prompt).toContain("Fix a");
    expect(prompt).toContain("quote a");
  });
  it("says so when there is nothing to fix", () => {
    expect(buildFixPrompt({ url: "https://example.com/", findings: [] })).toContain("found no issues");
  });
});
