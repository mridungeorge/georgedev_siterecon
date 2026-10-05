import { describe, it, expect, beforeEach } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "@/lib/db";
import { parseRobots, isAllowed } from "@/lib/robots";
import { commitRateLimit, refundRateLimit, peekRateLimit, REFUND_LIMIT_PER_HOUR } from "@/lib/rate-limit";
import { collectSnapshot, TargetUnreachableError, type PageFetcher } from "@/lib/snapshot";
import { handleScan, type ScanDeps } from "@/lib/scan-handler";
import { ScanQueue } from "@/lib/scan-queue";
import { page } from "./helpers/snap";

const UA = "SiteReconBot/0.1 (+https://siterecon.georgemridun.dev/methodology)";
const T0 = 1_800_000_000_000;
const cfg = { perIpHour: 99, perIpDay: 99, globalDay: 99, perTargetHour: 3 };

describe("I5: robots.txt group selection", () => {
  it("merges several groups for the same agent, so a later Disallow: / is honoured", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /private\n\nUser-agent: *\nDisallow: /\n");
    expect(isAllowed(rules, UA, "/")).toBe(false);
  });
  it("ignores an empty User-agent line", () => {
    expect(isAllowed(parseRobots("User-agent:\nDisallow: /\n"), UA, "/")).toBe(true);
  });
  it("matches whole product tokens, not substrings of the user agent", () => {
    for (const token of ["bot", "dev", "http", "recon", "site"]) {
      const rules = parseRobots(`User-agent: ${token}\nDisallow: /\n`);
      expect(isAllowed(rules, UA, "/"), `token ${token} vs SiteReconBot`).toBe(true);
      expect(isAllowed(rules, "GPTBot", "/"), `token ${token} vs GPTBot`).toBe(true);
    }
  });
  it("still matches our own token and a token inside a longer user agent", () => {
    expect(isAllowed(parseRobots("User-agent: SiteReconBot\nDisallow: /\n"), UA, "/")).toBe(false);
    expect(isAllowed(parseRobots("User-agent: GPTBot\nDisallow: /\n"), "Mozilla/5.0 (compatible; GPTBot/1.2)", "/")).toBe(false);
  });
});

describe("I2: refunds must not erase traffic that was really sent", () => {
  let db: DatabaseSync;
  beforeEach(() => { db = openDb(":memory:"); });
  const count = (bucket: string) =>
    (db.prepare("SELECT COUNT(*) AS c FROM hits WHERE bucket = ?").get(bucket) as { c: number }).c;

  it("refunds only the visitor's own bucket and keeps the global and per-target hits", () => {
    const token = commitRateLimit(db, "1.1.1.1", "victim.com", T0);
    refundRateLimit(db, "1.1.1.1", "victim.com", token);
    expect(count("ip:1.1.1.1")).toBe(0);
    expect(count("global")).toBe(1);
    expect(count("target:victim.com")).toBe(1);
  });
  it("so the per-target limit still stops repeated scans of a host that keeps failing", () => {
    for (let i = 0; i < 3; i++) {
      const token = commitRateLimit(db, `9.9.9.${i}`, "victim.com", T0 + i);
      refundRateLimit(db, `9.9.9.${i}`, "victim.com", token);
    }
    expect(peekRateLimit(db, "8.8.8.8", "victim.com", T0 + 10, cfg).reason).toBe("per-target");
  });
  it("caps how many refunded scans one visitor can have per hour", () => {
    for (let i = 0; i < REFUND_LIMIT_PER_HOUR; i++) {
      const token = commitRateLimit(db, "1.1.1.1", `site${i}.com`, T0 + i);
      refundRateLimit(db, "1.1.1.1", `site${i}.com`, token);
    }
    const blocked = peekRateLimit(db, "1.1.1.1", "fresh.com", T0 + 100, cfg);
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toBe("per-ip");
    expect(peekRateLimit(db, "2.2.2.2", "fresh.com", T0 + 100, cfg).allowed).toBe(true);
  });
});

describe("I4: a homepage that blocks or fails is reported as such, not audited", () => {
  const O = "https://example.com";
  const home = (status: number): PageFetcher => async (url) =>
    url === `${O}/` ? page(url, "<html><body>Access denied</body></html>", { status }) : page(url, "nope", { status: 404 });

  it.each([401, 403, 429])("HTTP %i is reported as blocking automated access", async (status) => {
    const err = await collectSnapshot(new URL(`${O}/`), home(status)).catch((e) => e);
    expect(err).toBeInstanceOf(TargetUnreachableError);
    expect(err.message).toMatch(/blocks automated access/);
    expect(err.message).toContain(String(status));
  });
  it.each([500, 502, 503])("HTTP %i is reported as the site having an error", async (status) => {
    const err = await collectSnapshot(new URL(`${O}/`), home(status)).catch((e) => e);
    expect(err).toBeInstanceOf(TargetUnreachableError);
    expect(err.message).toMatch(/returned an error/);
  });
  it("still audits a normal 200 homepage", async () => {
    const { snapshot } = await collectSnapshot(new URL(`${O}/`), home(200));
    expect(snapshot.home.status).toBe(200);
  });
});

describe("scan handler fixes", () => {
  let db: DatabaseSync;
  let deps: ScanDeps;
  const HOME = `<html lang="en"><head><title>Acme Storage shelving</title></head><body><h1>Shelving</h1></body></html>`;
  const req = (query: string) => handleScan(new Request(`https://siterecon.test/api/scan/stream${query}`), deps);
  const hitCount = (bucket: string) =>
    (db.prepare("SELECT COUNT(*) AS c FROM hits WHERE bucket = ?").get(bucket) as { c: number }).c;

  beforeEach(() => {
    db = openDb(":memory:");
    deps = {
      db, queue: new ScanQueue(1, 5),
      fetchPage: async (url) => (url === "https://example.com/" ? page(url, HOME) : page(url, "nope", { status: 404 })),
    };
  });

  it("I3: always scans the site root, so a subpage cannot poison the cached report", async () => {
    const urls: string[] = [];
    deps.fetchPage = async (url) => {
      urls.push(url);
      return url === "https://example.com/" ? page(url, HOME) : page(url, "nope", { status: 404 });
    };
    const first = await (await req("?url=example.com/nope/page?x=1")).text();
    expect(urls).not.toContain("https://example.com/nope/page?x=1");
    expect(urls).toContain("https://example.com/");
    expect(first).toContain('"url":"https://example.com/"');
    const second = await (await req("?url=example.com")).text();
    expect(second).toMatch(/^event: cached/);
  });

  it("I4: a blocked homepage is not cached and costs the visitor nothing", async () => {
    deps.fetchPage = async (url) =>
      url === "https://example.com/" ? page(url, "<html>Access denied</html>", { status: 403 }) : page(url, "nope", { status: 404 });
    const text = await (await req("?url=example.com")).text();
    expect(text).toMatch(/event: error/);
    expect(text).toMatch(/blocks automated access/);
    expect(db.prepare("SELECT COUNT(*) AS c FROM reports").get()).toEqual({ c: 0 });
    expect(hitCount("ip:untrusted-client")).toBe(0);
    expect(hitCount("target:example.com")).toBe(1); // the request really was sent
  });

  it("I1: a visitor disconnecting aborts the in-flight fetch and frees the slot only afterwards", async () => {
    const signals: AbortSignal[] = [];
    deps.queue = new ScanQueue(1, 0);
    deps.fetchPage = (_url, signal) =>
      new Promise((_, reject) => {
        signals.push(signal!);
        signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    const res = await req("?url=example.com");
    const reader = res.body!.getReader();
    await reader.read(); // step-start
    await new Promise((r) => setTimeout(r, 10)); // the first fetch is now in flight
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((s) => !s.aborted)).toBe(true);
    await reader.cancel();
    await new Promise((r) => setTimeout(r, 30));
    expect(signals.every((s) => s.aborted)).toBe(true);
    expect(deps.queue.tryEnter()).not.toBeNull();
  });

  it("I1: never runs more than one scan at a time when visitors keep disconnecting", async () => {
    let inFlight = 0;
    let peak = 0;
    deps.queue = new ScanQueue(1, 5);
    deps.fetchPage = (_url, signal) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      return new Promise((_, reject) => {
        signal!.addEventListener("abort", () => { inFlight--; reject(new Error("aborted")); }, { once: true });
      });
    };
    const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
    for (const site of ["a.com", "b.com", "c.com", "d.com"]) {
      readers.push((await req(`?url=${site}`)).body!.getReader());
    }
    await new Promise((r) => setTimeout(r, 10));
    for (const r of readers) await r.cancel();
    await new Promise((r) => setTimeout(r, 60));
    expect(peak).toBe(1);
    expect(inFlight).toBe(0);
  });

  it("I1: a visitor who disconnects while queued never starts a scan", async () => {
    let started = 0;
    deps.queue = new ScanQueue(1, 5);
    deps.fetchPage = (_url, signal) => {
      started++;
      return new Promise((_, reject) => signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    };
    const first = (await req("?url=a.com")).body!.getReader();
    await new Promise((r) => setTimeout(r, 10));
    const queued = (await req("?url=b.com")).body!.getReader();
    await queued.cancel(); // leaves the queue before its turn
    const startedBeforeRelease = started;
    await first.cancel();
    await new Promise((r) => setTimeout(r, 60));
    expect(started).toBe(startedBeforeRelease);
  });
});
