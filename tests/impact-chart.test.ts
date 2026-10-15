import { describe, it, expect } from "vitest";
import { layoutImpactChart } from "@/lib/impact-chart";
import type { Effort, Finding, Severity } from "@/lib/pipeline/schemas";

const f = (id: string, severity: Severity, effort: Effort): Finding => ({
  id: `technical:${id}`, module: "technical", severity, effort, title: id, detail: "d", fix: "x", evidence: [{ url: "https://example.com/", note: "n" }],
});

describe("layoutImpactChart", () => {
  const W = 400;
  const H = 300;

  it("puts quick wins top left, big bets top right, fill-ins bottom left and deprioritised bottom right", () => {
    const { dots } = layoutImpactChart([f("a", "critical", "low"), f("b", "high", "high"), f("c", "low", "low"), f("d", "low", "high")], W, H);
    const at = (id: string) => dots.find((d) => d.id === `technical:${id}`)!;
    expect(at("a").x).toBeLessThan(W / 2); expect(at("a").y).toBeLessThan(H / 2);
    expect(at("b").x).toBeGreaterThan(W / 2); expect(at("b").y).toBeLessThan(H / 2);
    expect(at("c").x).toBeLessThan(W / 2); expect(at("c").y).toBeGreaterThan(H / 2);
    expect(at("d").x).toBeGreaterThan(W / 2); expect(at("d").y).toBeGreaterThan(H / 2);
  });

  it("numbers the dots from 1 in a stable order, so the legend can refer to them", () => {
    const { dots } = layoutImpactChart([f("x", "low", "high"), f("y", "critical", "low")], W, H);
    expect(dots.map((d) => d.n).sort()).toEqual([1, 2]);
    expect(dots.find((d) => d.id === "technical:y")!.n).toBe(1);
  });

  it("keeps every dot inside the chart and apart from the others, however many findings there are", () => {
    const many = Array.from({ length: 60 }, (_, i) => f(`f${i}`, i % 2 ? "high" : "low", i % 3 === 0 ? "high" : "low"));
    const { dots, radius } = layoutImpactChart(many, W, H);
    expect(dots).toHaveLength(60);
    for (const d of dots) {
      expect(d.x - radius).toBeGreaterThanOrEqual(0); expect(d.x + radius).toBeLessThanOrEqual(W);
      expect(d.y - radius).toBeGreaterThanOrEqual(0); expect(d.y + radius).toBeLessThanOrEqual(H);
    }
    for (let i = 0; i < dots.length; i++) {
      for (let j = i + 1; j < dots.length; j++) {
        const dist = Math.hypot(dots[i]!.x - dots[j]!.x, dots[i]!.y - dots[j]!.y);
        expect(dist, `${dots[i]!.id} and ${dots[j]!.id}`).toBeGreaterThanOrEqual(radius * 1.5);
      }
    }
  });

  it("returns no dots for no findings", () => {
    expect(layoutImpactChart([], W, H).dots).toEqual([]);
  });
});
