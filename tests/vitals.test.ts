import { describe, it, expect } from "vitest";
import { runPerformanceChecks, type PageSpeedDeps } from "@/lib/checks/performance";
import { FindingSchema } from "@/lib/pipeline/schemas";

// A PageSpeed answer with the audit details Lighthouse returns: which element was the LCP, which
// elements shifted, which files block rendering, and the field INP from real users.
const DETAILED = {
  loadingExperience: { metrics: { INTERACTION_TO_NEXT_PAINT: { percentile: 380, category: "AVERAGE" } } },
  lighthouseResult: {
    categories: { performance: { score: 0.4 } },
    audits: {
      "largest-contentful-paint": { numericValue: 5200 },
      "cumulative-layout-shift": { numericValue: 0.31 },
      "total-blocking-time": { numericValue: 700 },
      "first-contentful-paint": { numericValue: 2500 },
      "largest-contentful-paint-element": {
        details: { items: [{ type: "table", items: [{ node: { selector: "body > div.hero > img", snippet: '<img src="/img/hero.jpg" class="hero-img">', nodeLabel: "Hero" } }] }] },
      },
      "layout-shifts": {
        details: { items: [{ node: { selector: "div.banner", snippet: '<div class="banner">' }, score: 0.22 }, { node: { selector: "img.logo", snippet: "<img>" }, score: 0.09 }] },
      },
      "render-blocking-resources": {
        details: { items: [{ url: "https://example.com/css/site.css", wastedMs: 640 }, { url: "https://example.com/js/app.js", wastedMs: 310 }] },
      },
      "bootup-time": {
        details: { items: [{ url: "https://cdn.example.net/tracker.js", total: 900, scripting: 700 }, { url: "https://example.com/js/app.js", total: 300, scripting: 200 }] },
      },
    },
  },
};

const deps = (response: unknown): PageSpeedDeps => ({ apiKey: "k", quotaOk: () => true, fetchJson: async () => response });

describe("Core Web Vitals mapped to elements and files", () => {
  it("names the LCP element and the image file in the LCP finding", async () => {
    const r = await runPerformanceChecks("https://example.com/", deps(DETAILED));
    const f = r.outcomes.find((o) => o.id === "lcp")!.finding!;
    expect(f.evidence.map((e) => e.note).join(" ")).toMatch(/LCP element: body > div\.hero > img/);
    expect(f.evidence.some((e) => e.url === "https://example.com/img/hero.jpg")).toBe(true);
  });

  it("names the elements that shifted in the CLS finding, largest first", async () => {
    const r = await runPerformanceChecks("https://example.com/", deps(DETAILED));
    const f = r.outcomes.find((o) => o.id === "cls")!.finding!;
    expect(f.evidence[1]!.note).toMatch(/div\.banner/);
    expect(f.evidence[1]!.note).toMatch(/0\.22/);
  });

  it("names the heaviest scripts in the blocking-time finding", async () => {
    const r = await runPerformanceChecks("https://example.com/", deps(DETAILED));
    const f = r.outcomes.find((o) => o.id === "tbt")!.finding!;
    expect(f.evidence.some((e) => e.url === "https://cdn.example.net/tracker.js")).toBe(true);
  });

  it("reports vitals, render blockers and field INP as insights", async () => {
    const r = await runPerformanceChecks("https://example.com/", deps(DETAILED));
    expect(r.vitals).toMatchObject({
      lcp: { ms: 5200, element: "body > div.hero > img", resource: "https://example.com/img/hero.jpg" },
      cls: { value: 0.31, shifts: [{ selector: "div.banner", score: 0.22 }, { selector: "img.logo", score: 0.09 }] },
      inp: { ms: 380, rating: "needs improvement" },
      blockers: [{ url: "https://example.com/css/site.css", wastedMs: 640 }, { url: "https://example.com/js/app.js", wastedMs: 310 }],
    });
  });

  it("still scores a page when PageSpeed returns no audit details", async () => {
    const bare = { lighthouseResult: { categories: { performance: { score: 0.95 } }, audits: {
      "largest-contentful-paint": { numericValue: 1800 }, "cumulative-layout-shift": { numericValue: 0.02 },
      "total-blocking-time": { numericValue: 100 }, "first-contentful-paint": { numericValue: 1000 } } } };
    const r = await runPerformanceChecks("https://example.com/", deps(bare));
    expect(r.outcomes.every((o) => o.passed)).toBe(true);
    expect(r.vitals?.inp).toBeNull();
    expect(r.vitals?.lcp.element).toBeNull();
  });

  it("keeps every finding valid, with page text cut short", async () => {
    const long = { ...DETAILED, lighthouseResult: { ...DETAILED.lighthouseResult, audits: { ...DETAILED.lighthouseResult.audits,
      "largest-contentful-paint-element": { details: { items: [{ items: [{ node: { selector: "x".repeat(900), snippet: "y".repeat(900) } }] }] } } } } };
    const r = await runPerformanceChecks("https://example.com/", deps(long));
    for (const o of r.outcomes.filter((x) => !x.passed)) {
      const f = FindingSchema.parse(o.finding);
      for (const e of f.evidence) expect((e.note ?? "").length + (e.quote ?? "").length).toBeLessThan(700);
    }
  });
});

describe("script attribution", () => {
  it("leaves out work PageSpeed could not attribute to an address", async () => {
    const data = JSON.parse(JSON.stringify(DETAILED));
    data.lighthouseResult.audits["bootup-time"].details.items.push({ url: "Unattributable", total: 1200, scripting: 1000 });
    const r = await runPerformanceChecks("https://example.com/", { apiKey: "k", quotaOk: () => true, fetchJson: async () => data });
    expect(r.vitals!.heavyScripts.map((h) => h.url)).not.toContain("Unattributable");
    const f = r.outcomes.find((o) => o.id === "tbt")!.finding!;
    expect(f.evidence.map((e) => e.url)).not.toContain("Unattributable");
  });
});
