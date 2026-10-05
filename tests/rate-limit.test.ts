import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "@/lib/db";
import { peekRateLimit, commitRateLimit, refundRateLimit, getClientIp, configFromEnv } from "@/lib/rate-limit";

const cfg = { perIpHour: 2, perIpDay: 3, globalDay: 5, perTargetHour: 2 };
const HOUR = 3_600_000;
const T0 = 1_800_000_000_000;
let db: DatabaseSync;

beforeEach(() => { db = openDb(":memory:"); });

describe("rate limit", () => {
  it("allows a first scan and peeking does not consume", () => {
    expect(peekRateLimit(db, "1.1.1.1", "a.com", T0, cfg)).toEqual({ allowed: true });
    expect(peekRateLimit(db, "1.1.1.1", "a.com", T0, cfg)).toEqual({ allowed: true });
  });

  it("blocks an IP at its hourly limit and says when to retry", () => {
    commitRateLimit(db, "1.1.1.1", "a.com", T0);
    commitRateLimit(db, "1.1.1.1", "b.com", T0 + 1000);
    const r = peekRateLimit(db, "1.1.1.1", "c.com", T0 + 2000, cfg);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("per-ip");
    expect(r.retryAfterMs).toBe(HOUR - 2000);
  });

  it("lets the same IP scan again after the hour, until the daily limit", () => {
    commitRateLimit(db, "1.1.1.1", "a.com", T0);
    commitRateLimit(db, "1.1.1.1", "b.com", T0 + 1);
    expect(peekRateLimit(db, "1.1.1.1", "c.com", T0 + HOUR + 10, cfg).allowed).toBe(true);
    commitRateLimit(db, "1.1.1.1", "c.com", T0 + HOUR + 10);
    expect(peekRateLimit(db, "1.1.1.1", "d.com", T0 + 2 * HOUR + 20, cfg).reason).toBe("per-ip-daily");
  });

  it("limits scans of one target across different visitors", () => {
    commitRateLimit(db, "1.1.1.1", "a.com", T0);
    commitRateLimit(db, "2.2.2.2", "a.com", T0 + 1);
    expect(peekRateLimit(db, "3.3.3.3", "a.com", T0 + 2, cfg).reason).toBe("per-target");
    expect(peekRateLimit(db, "3.3.3.3", "b.com", T0 + 2, cfg).allowed).toBe(true);
  });

  it("enforces the global daily cap", () => {
    for (let i = 0; i < 5; i++) commitRateLimit(db, `9.9.9.${i}`, `site${i}.com`, T0 + i);
    expect(peekRateLimit(db, "8.8.8.8", "new.com", T0 + 10, cfg).reason).toBe("global");
  });

  it("refund gives the scan back", () => {
    commitRateLimit(db, "1.1.1.1", "a.com", T0);
    const token = commitRateLimit(db, "1.1.1.1", "b.com", T0 + 5);
    expect(peekRateLimit(db, "1.1.1.1", "c.com", T0 + 6, cfg).allowed).toBe(false);
    refundRateLimit(db, "1.1.1.1", "b.com", token);
    expect(peekRateLimit(db, "1.1.1.1", "c.com", T0 + 6, cfg).allowed).toBe(true);
  });

  it("survives reopening the database file", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "siterecon-"));
    const file = join(dir, "t.db");
    const a = openDb(file);
    commitRateLimit(a, "1.1.1.1", "a.com", T0);
    commitRateLimit(a, "1.1.1.1", "b.com", T0 + 1);
    a.close();
    const b = openDb(file);
    expect(peekRateLimit(b, "1.1.1.1", "c.com", T0 + 2, cfg).allowed).toBe(false);
    b.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("configFromEnv", () => {
  it("uses the spec defaults and reads overrides", () => {
    expect(configFromEnv({})).toEqual({ perIpHour: 5, perIpDay: 10, globalDay: 50, perTargetHour: 3 });
    expect(configFromEnv({ RL_GLOBAL_DAY: "7", RL_PER_IP_HOUR: "junk" }).globalDay).toBe(7);
    expect(configFromEnv({ RL_PER_IP_HOUR: "junk" }).perIpHour).toBe(5);
  });
});

describe("getClientIp", () => {
  const saved = process.env.TRUST_PROXY;
  afterEach(() => {
    if (saved === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = saved;
  });
  const req = (h: Record<string, string>) => new Request("https://x.test/", { headers: h });

  it("ignores forwarded headers unless TRUST_PROXY is true", () => {
    delete process.env.TRUST_PROXY;
    expect(getClientIp(req({ "x-forwarded-for": "5.5.5.5" }))).toBe("untrusted-client");
  });
  it("uses the first forwarded address when the proxy is trusted", () => {
    process.env.TRUST_PROXY = "true";
    expect(getClientIp(req({ "x-forwarded-for": "5.5.5.5, 10.0.0.1" }))).toBe("5.5.5.5");
    expect(getClientIp(req({}))).toBe("unknown");
  });
});
