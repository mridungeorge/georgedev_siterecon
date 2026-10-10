import { describe, it, expect } from "vitest";
import { rubricTable } from "@/lib/methodology";
import { MODULE_WEIGHTS } from "@/lib/scoring";

describe("rubricTable (the /methodology page is built from the real checks)", () => {
  it("lists every scored module with check weights that add up to 100", async () => {
    const table = await rubricTable();
    expect(table.map((m) => m.module)).toEqual(["technical", "geo", "content", "marketing", "performance", "social"]);
    for (const m of table) {
      expect(m.checks.length, m.module).toBeGreaterThan(3);
      expect(m.checks.reduce((sum, c) => sum + c.weight, 0), `${m.module} weights`).toBe(100);
      expect(m.weightInOverall).toBe(MODULE_WEIGHTS[m.module]);
    }
  });

  it("describes each check in plain words and says where its data comes from", async () => {
    const table = await rubricTable();
    for (const m of table) {
      for (const c of m.checks) {
        expect(c.id).toMatch(/^[a-z0-9-]+$/);
        expect(c.label.length, `${m.module}:${c.id}`).toBeGreaterThan(8);
      }
      expect(m.source.length).toBeGreaterThan(10);
    }
  });

  it("marks the checks an AI review contributes to, and keeps them at 20 points", async () => {
    const content = (await rubricTable()).find((m) => m.module === "content")!;
    const ai = content.checks.filter((c) => c.ai);
    expect(ai).toHaveLength(4);
    expect(ai.reduce((sum, c) => sum + c.weight, 0)).toBe(20);
  });

  it("includes the checks that need the optional services", async () => {
    const table = await rubricTable();
    expect(table.find((m) => m.module === "social")!.checks.map((c) => c.id)).toEqual(expect.arrayContaining(["profiles-reachable", "profile-activity"]));
    expect(table.find((m) => m.module === "performance")!.checks.map((c) => c.id)).toEqual(expect.arrayContaining(["lcp", "cls"]));
  });
});
