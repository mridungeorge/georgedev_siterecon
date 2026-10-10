import { describe, it, expect } from "vitest";
import { readingEase } from "@/lib/checks/readability";

describe("readingEase", () => {
  it("scores short plain sentences as easy", () => {
    const r = readingEase("We make shelves. They fit small rooms. You pick a size. We send it to your door.")!;
    expect(r.ease).toBeGreaterThan(80);
    expect(r.words).toBe(17);
  });
  it("scores long jargon-heavy sentences as hard", () => {
    const r = readingEase("The organisational infrastructure facilitates comprehensive operationalisation of multidimensional methodologies, notwithstanding considerable interdepartmental heterogeneity.")!;
    expect(r.ease).toBeLessThan(0);
  });
  it("is higher for the plain text than for the dense text", () => {
    expect(readingEase("Our bread is baked fresh. Come in and try a loaf.")!.ease).toBeGreaterThan(readingEase("Notwithstanding considerable organisational heterogeneity, comprehensive standardisation remains operationally unattainable.")!.ease);
  });
  it("has nothing to say about empty or symbol-only text", () => {
    expect(readingEase("")).toBeNull();
    expect(readingEase("  ...  !!! 123 ")).toBeNull();
  });
  it("copes with text that has no full stop", () => {
    expect(readingEase("one two three")!.words).toBe(3);
  });
});
