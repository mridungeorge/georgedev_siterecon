import { describe, it, expect } from "vitest";
import { browserVitals, mergeBrowserVitals } from "@/lib/checks/vitals";
import type { Vitals } from "@/lib/checks/performance";

const rendered = { words: 300, mobileOverflow: false, lcpMs: 2100, clsMilli: 180, inpMs: 240, lcpTag: "img" };

describe("browserVitals", () => {
  it("builds vitals from what the browser measured, marking the source", () => {
    const v = browserVitals(rendered)!;
    expect(v.source).toBe("browser");
    expect(v.lcp).toEqual({ ms: 2100, element: "img element", resource: null });
    expect(v.cls).toEqual({ value: 0.18, shifts: [] });
    expect(v.inp).toEqual({ ms: 240, rating: "needs improvement", source: "lab" });
  });

  it("returns null when the browser reported no largest paint, because 0 means not measured", () => {
    expect(browserVitals({ ...rendered, lcpMs: 0 })).toBeNull();
    expect(browserVitals({ words: 1, mobileOverflow: false })).toBeNull();
  });

  it("treats an inp of 0 as not measured", () => {
    expect(browserVitals({ ...rendered, inpMs: 0 })!.inp).toBeNull();
  });
});

describe("mergeBrowserVitals", () => {
  const psi: Vitals = {
    source: "pagespeed",
    lcp: { ms: 5200, element: "div.hero > img", resource: "https://x.example/h.jpg" },
    cls: { value: 0.3, shifts: [] },
    inp: null,
    blockers: [],
    heavyScripts: [],
  };

  it("keeps PageSpeed's numbers and adds the lab INP only when there is no field INP", () => {
    const merged = mergeBrowserVitals(psi, rendered)!;
    expect(merged.lcp.ms).toBe(5200);
    expect(merged.inp).toEqual({ ms: 240, rating: "needs improvement", source: "lab" });
  });

  it("does not replace a field INP with a lab one", () => {
    const field = { ...psi, inp: { ms: 300, rating: "needs improvement" as const, source: "field" as const } };
    expect(mergeBrowserVitals(field, rendered)!.inp!.source).toBe("field");
  });

  it("returns the browser vitals when PageSpeed gave none, and null when neither did", () => {
    expect(mergeBrowserVitals(null, rendered)?.source).toBe("browser");
    expect(mergeBrowserVitals(null, undefined)).toBeNull();
  });
});
