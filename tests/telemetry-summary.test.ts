import { describe, it, expect } from "vitest";
import { openDb } from "@/lib/db";
import { saveReport } from "@/lib/report-store";
import { summariseTelemetry } from "@/lib/telemetry-summary";
import type { Report } from "@/lib/pipeline/schemas";
import type { Telemetry } from "@/lib/telemetry";

const T0 = Date.parse("2026-10-05T00:00:00.000Z");
const withTelemetry = (id: string, telemetry: Telemetry | null): Report => ({
  id, url: "https://example.com/", domain: "example.com", createdAt: new Date(T0).toISOString(), overallScore: 70,
  modules: [], topFixes: [], fixPrompt: "p", couldntCheck: [], pagesScanned: [], injectionFlags: 0, ideas: [], social: null, competitors: null,
  summary: null, fixKit: [], pageTable: [], aiReadiness: null, telemetry, insights: null,
});
const tel = (steps: [string, number, "done" | "warned"][]): Telemetry => ({
  steps: steps.map(([step, ms, outcome]) => ({ step, ms, outcome })),
  totalMs: steps.reduce((s, x) => s + x[1], 0), providers: [], estimatedCostUsd: 0, calls: {},
});

describe("summariseTelemetry", () => {
  it("returns zero scans for an empty store", () => {
    const s = summariseTelemetry(openDb(":memory:"), T0);
    expect(s.scans).toBe(0);
    expect(s.steps).toEqual([]);
  });

  it("reports the median, the slowest and the warning rate for each step", () => {
    const db = openDb(":memory:");
    saveReport(db, withTelemetry("a", tel([["fetch", 100, "done"], ["performance", 4000, "done"]])));
    saveReport(db, withTelemetry("b", tel([["fetch", 300, "done"], ["performance", 100, "warned"]])));
    saveReport(db, withTelemetry("c", tel([["fetch", 200, "done"]])));
    const s = summariseTelemetry(db, T0 + 1000);
    expect(s.scans).toBe(3);
    const fetch = s.steps.find((x) => x.step === "fetch")!;
    expect(fetch).toMatchObject({ runs: 3, medianMs: 200, maxMs: 300, warnRate: 0 });
    const perf = s.steps.find((x) => x.step === "performance")!;
    expect(perf).toMatchObject({ runs: 2, warnRate: 0.5, maxMs: 4000 });
  });

  it("skips reports stored before telemetry existed", () => {
    const db = openDb(":memory:");
    saveReport(db, withTelemetry("old", null));
    saveReport(db, withTelemetry("new", tel([["fetch", 50, "done"]])));
    expect(summariseTelemetry(db, T0 + 1000).scans).toBe(1);
  });
});
