import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";

describe("tooling", () => {
  it("runs tests and has built-in SQLite", () => {
    const db = new DatabaseSync(":memory:");
    const row = db.prepare("SELECT 1 AS n").get() as { n: number };
    expect(row.n).toBe(1);
  });
});
