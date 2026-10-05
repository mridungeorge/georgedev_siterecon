import { describe, it, expect, beforeEach } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "@/lib/db";
import { tryConsumeQuota, quotaLimits } from "@/lib/quota";

const T0 = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const limits = { llm: 2, pagespeed: 1, search: 1 };
let db: DatabaseSync;
beforeEach(() => { db = openDb(":memory:"); });

describe("provider quota guard", () => {
  it("allows calls up to the daily limit and then refuses", () => {
    expect(tryConsumeQuota(db, "llm", T0, limits)).toBe(true);
    expect(tryConsumeQuota(db, "llm", T0 + 1, limits)).toBe(true);
    expect(tryConsumeQuota(db, "llm", T0 + 2, limits)).toBe(false);
  });
  it("counts each provider separately", () => {
    expect(tryConsumeQuota(db, "pagespeed", T0, limits)).toBe(true);
    expect(tryConsumeQuota(db, "pagespeed", T0 + 1, limits)).toBe(false);
    expect(tryConsumeQuota(db, "llm", T0 + 1, limits)).toBe(true);
  });
  it("frees quota again once the day has passed", () => {
    tryConsumeQuota(db, "pagespeed", T0, limits);
    expect(tryConsumeQuota(db, "pagespeed", T0 + DAY - 1, limits)).toBe(false);
    expect(tryConsumeQuota(db, "pagespeed", T0 + DAY + 1, limits)).toBe(true);
  });
  it("a refused call does not use up quota", () => {
    tryConsumeQuota(db, "pagespeed", T0, limits);
    for (let i = 0; i < 5; i++) tryConsumeQuota(db, "pagespeed", T0 + i + 1, limits);
    expect(tryConsumeQuota(db, "pagespeed", T0 + DAY + 1, limits)).toBe(true);
  });
});

describe("quotaLimits", () => {
  it("has conservative free-tier defaults and reads overrides", () => {
    expect(quotaLimits({})).toEqual({ llm: 400, pagespeed: 200, search: 30 });
    expect(quotaLimits({ QUOTA_LLM_DAY: "50", QUOTA_PAGESPEED_DAY: "junk" })).toEqual({ llm: 50, pagespeed: 200, search: 30 });
  });
});
