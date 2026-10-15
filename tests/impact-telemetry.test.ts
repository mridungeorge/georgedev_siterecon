import { describe, it, expect } from "vitest";
import { buildImpactMatrix } from "@/lib/impact-matrix";
import { createTelemetryRecorder } from "@/lib/telemetry";
import type { Effort, Finding, ModuleName, Severity } from "@/lib/pipeline/schemas";

const f = (id: string, severity: Severity, effort: Effort, module: ModuleName = "technical"): Finding => ({
  id: `${module}:${id}`, module, severity, effort, title: id, detail: "d", fix: "x", evidence: [{ url: "https://example.com/", note: "n" }],
});

describe("buildImpactMatrix", () => {
  it("puts high impact and low effort in quick wins, high impact and high effort in big bets", () => {
    const m = buildImpactMatrix([f("a", "critical", "low"), f("b", "high", "medium"), f("c", "critical", "high"), f("d", "low", "low"), f("e", "low", "high")]);
    expect(m.quickWins.map((x) => x.id)).toEqual(["technical:a", "technical:b"]);
    expect(m.bigBets.map((x) => x.id)).toEqual(["technical:c"]);
    expect(m.fillIns.map((x) => x.id)).toEqual(["technical:d"]);
    expect(m.deprioritise.map((x) => x.id)).toEqual(["technical:e"]);
  });

  it("treats medium severity as lower impact and keeps every finding in exactly one quadrant", () => {
    const all = [f("a", "medium", "low"), f("b", "medium", "high"), f("c", "high", "high"), f("d", "critical", "medium")];
    const m = buildImpactMatrix(all);
    const placed = [...m.quickWins, ...m.bigBets, ...m.fillIns, ...m.deprioritise];
    expect(placed).toHaveLength(all.length);
    expect(new Set(placed.map((x) => x.id)).size).toBe(all.length);
  });

  it("orders each quadrant by severity, then by effort", () => {
    const m = buildImpactMatrix([f("x", "high", "medium"), f("y", "critical", "medium"), f("z", "critical", "low")]);
    expect(m.quickWins.map((x) => x.id)).toEqual(["technical:z", "technical:y", "technical:x"]);
  });
});

describe("telemetry recorder", () => {
  it("records a duration and an outcome for each step", () => {
    let now = 1000;
    const t = createTelemetryRecorder(() => now);
    t.start("fetch"); now += 400; t.done("fetch");
    t.start("render"); now += 90; t.warn("render");
    const out = t.finish({ llm: true, pagespeed: false, fetchService: true });
    expect(out.steps).toEqual([
      { step: "fetch", ms: 400, outcome: "done" },
      { step: "render", ms: 90, outcome: "warned" },
    ]);
    expect(out.totalMs).toBe(490);
  });

  it("counts provider use and reports a zero cost, because every provider runs on a free tier", () => {
    const t = createTelemetryRecorder(() => 0);
    t.start("content"); t.done("content");
    t.start("performance"); t.warn("performance");
    const out = t.finish({ llm: true, pagespeed: true, fetchService: false });
    expect(out.providers.find((p) => p.provider === "llm")?.steps).toContain("content");
    expect(out.providers.find((p) => p.provider === "pagespeed")?.steps).toEqual([]);
    expect(out.estimatedCostUsd).toBe(0);
  });

  it("records how many calls each outside provider received and still reports a zero cost", () => {
    const t = createTelemetryRecorder(() => 0);
    t.start("content"); t.done("content");
    const out = t.finish({ llm: true, pagespeed: true, fetchService: false }, { llm: 7, pagespeed: 1, search: 0, hackerNews: 1, authority: 1, pages: 52, fetchService: 0 });
    expect(out.calls).toEqual({ llm: 7, pagespeed: 1, search: 0, hackerNews: 1, authority: 1, pages: 52, fetchService: 0 });
    expect(out.estimatedCostUsd).toBe(0);
  });

  it("defaults the call counts to empty", () => {
    expect(createTelemetryRecorder(() => 0).finish({ llm: false, pagespeed: false, fetchService: false }).calls).toEqual({});
  });

  it("ignores a step that was never started", () => {
    const t = createTelemetryRecorder(() => 0);
    t.done("fetch");
    expect(t.finish({ llm: false, pagespeed: false, fetchService: false }).steps).toEqual([]);
  });
});
