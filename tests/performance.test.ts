import { describe, it, expect } from "vitest";
import { runPerformanceChecks, type PageSpeedDeps } from "@/lib/checks/performance";
import { FindingSchema } from "@/lib/pipeline/schemas";
import { buildModuleResult } from "@/lib/scoring";

const psi = (m: { score: number; lcp: number; cls: number; tbt: number; fcp: number }) => ({
  lighthouseResult: {
    categories: { performance: { score: m.score } },
    audits: {
      "largest-contentful-paint": { numericValue: m.lcp },
      "cumulative-layout-shift": { numericValue: m.cls },
      "total-blocking-time": { numericValue: m.tbt },
      "first-contentful-paint": { numericValue: m.fcp },
    },
  },
});
const GOOD = psi({ score: 0.95, lcp: 1800, cls: 0.02, tbt: 120, fcp: 1200 });
const BAD = psi({ score: 0.31, lcp: 6200, cls: 0.4, tbt: 900, fcp: 3900 });

function deps(over: Partial<PageSpeedDeps> & { response?: unknown } = {}): PageSpeedDeps & { urls: string[] } {
  const urls: string[] = [];
  return {
    apiKey: "key",
    quotaOk: () => true,
    fetchJson: async (url: string) => { urls.push(url); return over.response ?? GOOD; },
    ...over,
    urls,
  };
}
const failed = (r: Awaited<ReturnType<typeof runPerformanceChecks>>) => r.outcomes.filter((o) => !o.passed).map((o) => o.id);

describe("runPerformanceChecks", () => {
  it("passes a fast page and the weights total 100", async () => {
    const r = await runPerformanceChecks("https://example.com/", deps());
    expect(failed(r)).toEqual([]);
    expect(r.outcomes.reduce((sum, o) => sum + o.weight, 0)).toBe(100);
    expect(r.couldntCheck).toEqual([]);
  });

  it("flags every slow metric with the measured value as evidence", async () => {
    const r = await runPerformanceChecks("https://example.com/", deps({ response: BAD }));
    expect(failed(r).sort()).toEqual(["cls", "fcp", "lcp", "perf-score", "tbt"]);
    for (const o of r.outcomes.filter((x) => !x.passed)) expect(() => FindingSchema.parse(o.finding)).not.toThrow();
    const lcp = r.outcomes.find((o) => o.id === "lcp")!.finding!;
    expect(lcp.evidence[0].note).toMatch(/6\.2 s/);
    expect(lcp.evidence[0].note).toMatch(/PageSpeed/);
    expect(r.outcomes.find((o) => o.id === "perf-score")!.finding!.severity).toBe("high");
  });

  it("asks PageSpeed for the mobile run of the exact URL, with the key", async () => {
    const d = deps();
    await runPerformanceChecks("https://example.com/a b", d);
    expect(d.urls[0]).toContain("strategy=mobile");
    expect(d.urls[0]).toContain("key=key");
    expect(d.urls[0]).toContain(encodeURIComponent("https://example.com/a%20b"));
  });

  it.each([
    ["no API key", { apiKey: undefined }, /key/i],
    ["the daily PageSpeed budget used up", { quotaOk: () => false }, /daily/i],
  ])("does not call PageSpeed with %s", async (_, over, why) => {
    const d = deps(over as Partial<PageSpeedDeps>);
    const r = await runPerformanceChecks("https://example.com/", d);
    expect(d.urls).toHaveLength(0);
    expect(r.outcomes).toEqual([]);
    expect(r.couldntCheck[0].why).toMatch(why);
  });

  it.each([
    ["a failed request", { fetchJson: async () => { throw new Error("HTTP 500"); } }],
    ["an answer with no lighthouse data", { response: { error: "x" } }],
    ["an answer with missing metrics", { response: { lighthouseResult: { categories: {}, audits: {} } } }],
  ])("reports %s as could not check, without throwing", async (_, over) => {
    const r = await runPerformanceChecks("https://example.com/", deps(over as Partial<PageSpeedDeps> & { response?: unknown }));
    expect(r.outcomes).toEqual([]);
    expect(r.couldntCheck[0].what).toMatch(/PageSpeed/);
  });

  describe("partial credit (Google grades vitals as good, needs improvement or poor)", () => {
    const score = async (m: Parameters<typeof psi>[0]) => buildModuleResult("performance", (await runPerformanceChecks("https://example.com/", deps({ response: psi(m) }))).outcomes).score;
    it("gives a fast page full marks", async () => {
      expect(await score({ score: 0.95, lcp: 1800, cls: 0.02, tbt: 120, fcp: 1200 })).toBe(100);
    });
    it("gives half credit for every metric in the needs-improvement band, and the PageSpeed share for the score", async () => {
      // perf-score 40 x 0.85 + (lcp 20 + cls 15 + tbt 15 + fcp 10) x 0.5
      expect(await score({ score: 0.85, lcp: 3000, cls: 0.15, tbt: 400, fcp: 2200 })).toBe(64);
    });
    it("gives nothing for a metric in the poor band", async () => {
      // only the PageSpeed share remains: 40 x 0.31
      expect(await score({ score: 0.31, lcp: 6200, cls: 0.4, tbt: 900, fcp: 3900 })).toBe(12);
    });
    it("still reports a finding for each metric that is not good", async () => {
      const r = await runPerformanceChecks("https://example.com/", deps({ response: psi({ score: 0.85, lcp: 3000, cls: 0.15, tbt: 400, fcp: 2200 }) }));
      expect(failed(r).sort()).toEqual(["cls", "fcp", "lcp", "perf-score", "tbt"]);
    });
  });
});
