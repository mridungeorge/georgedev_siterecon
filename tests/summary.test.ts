import { describe, it, expect } from "vitest";
import { buildSummary } from "@/lib/summary";
import type { Effort, Finding, ModuleName, ModuleResult, Severity } from "@/lib/pipeline/schemas";

const finding = (module: ModuleName, id: string, severity: Severity, effort: Effort): Finding => ({
  id: `${module}:${id}`, module, severity, effort, title: id, detail: "d", fix: "f", evidence: [{ url: "https://example.com/", note: "n" }],
});
const mod = (module: ModuleName, score: number | null, findings: Finding[] = []): ModuleResult => ({
  module, status: "ok", score, findings, passed: [], couldntCheck: [],
});

describe("buildSummary", () => {
  it.each([
    [95, "A", "Excellent"], [90, "A", "Excellent"], [89, "B", "Strong"], [80, "B", "Strong"],
    [79, "C", "Decent"], [70, "C", "Decent"], [69, "D", "Needs work"], [60, "D", "Needs work"], [59, "F", "Needs urgent attention"], [0, "F", "Needs urgent attention"],
  ])("grades a score of %i as %s and opens the verdict with %s", (score, grade, word) => {
    const s = buildSummary([mod("technical", score)], score);
    expect(s.grade).toBe(grade);
    expect(s.verdict.startsWith(`${word} (${grade}, ${score}/100).`)).toBe(true);
  });

  it("says so plainly when nothing could be scored", () => {
    const s = buildSummary([mod("technical", null)], null);
    expect(s.grade).toBeNull();
    expect(s.verdict).toMatch(/could not score/i);
    expect(s.strongest).toBeNull();
    expect(s.weakest).toBeNull();
  });

  it("names the strongest and weakest areas, ignoring modules with no score", () => {
    const s = buildSummary([mod("technical", 84), mod("geo", 72), mod("content", 95), mod("performance", 40), mod("social", null)], 80);
    expect(s.strongest).toEqual({ module: "content", score: 95 });
    expect(s.weakest).toEqual({ module: "performance", score: 40 });
    expect(s.verdict).toContain("Strongest: Content and conversion (95)");
    expect(s.verdict).toContain("weakest: Speed (40)");
  });

  it("leaves out strongest and weakest when only one area was scored", () => {
    const s = buildSummary([mod("technical", 80), mod("social", null)], 80);
    expect(s.verdict).not.toMatch(/Strongest/);
  });

  it("counts issues by severity across every module", () => {
    const s = buildSummary([
      mod("technical", 70, [finding("technical", "a", "critical", "low"), finding("technical", "b", "medium", "low")]),
      mod("geo", 70, [finding("geo", "c", "medium", "medium"), finding("geo", "d", "low", "low")]),
    ], 70);
    expect(s.counts).toEqual({ critical: 1, high: 0, medium: 2, low: 1 });
    expect(s.verdict).toMatch(/4 issues found/);
  });

  it("reports a clean site as having nothing to fix", () => {
    const s = buildSummary([mod("technical", 100), mod("geo", 100)], 100);
    expect(s.counts).toEqual({ critical: 0, high: 0, medium: 0, low: 0 });
    expect(s.verdict).toMatch(/no issues/i);
    expect(s.roadmap).toEqual({ thisWeek: [], thisMonth: [], thisQuarter: [] });
    expect(s.quickWins).toEqual([]);
  });

  describe("roadmap", () => {
    const modules = [
      mod("technical", 60, [
        finding("technical", "low-effort-low", "low", "low"),
        finding("technical", "low-effort-critical", "critical", "low"),
        finding("technical", "mid-effort", "high", "medium"),
        finding("technical", "big-job", "medium", "high"),
      ]),
      mod("geo", 60, [finding("geo", "low-effort-medium", "medium", "low")]),
    ];
    const s = buildSummary(modules, 60);

    it("groups every finding by the effort to fix it", () => {
      expect(s.roadmap.thisWeek).toEqual(["technical:low-effort-critical", "geo:low-effort-medium", "technical:low-effort-low"]);
      expect(s.roadmap.thisMonth).toEqual(["technical:mid-effort"]);
      expect(s.roadmap.thisQuarter).toEqual(["technical:big-job"]);
    });
    it("puts the most severe first within each group, and keeps module order for ties", () => {
      const ids = s.roadmap.thisWeek;
      expect(ids[0]).toBe("technical:low-effort-critical");
      expect(ids.indexOf("geo:low-effort-medium")).toBeLessThan(ids.indexOf("technical:low-effort-low"));
    });
    it("lists the cheap, meaningful fixes as quick wins and leaves out trivial ones", () => {
      expect(s.quickWins).toEqual(["technical:low-effort-critical", "geo:low-effort-medium"]);
      expect(s.verdict).toMatch(/2 of them quick wins/);
    });
    it("lists each finding exactly once", () => {
      const all = [...s.roadmap.thisWeek, ...s.roadmap.thisMonth, ...s.roadmap.thisQuarter];
      expect(all).toHaveLength(5);
      expect(new Set(all).size).toBe(5);
    });
    it("caps quick wins at five", () => {
      const many = mod("technical", 50, Array.from({ length: 9 }, (_, i) => finding("technical", `q${i}`, "high", "low")));
      expect(buildSummary([many], 50).quickWins).toHaveLength(5);
    });
  });

  it("is deterministic", () => {
    const m = [mod("technical", 71, [finding("technical", "a", "high", "low")])];
    expect(buildSummary(m, 71)).toEqual(buildSummary(m, 71));
  });
});
