import { describe, it, expect, beforeEach } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "@/lib/db";
import { handleScan, type ScanDeps } from "@/lib/scan-handler";
import { ScanQueue } from "@/lib/scan-queue";
import { commitRateLimit, peekRateLimit } from "@/lib/rate-limit";
import type { PageFetcher } from "@/lib/snapshot";
import { page } from "./helpers/snap";

const HOME = `<html lang="en"><head><title>Acme Storage shelving</title></head><body><h1>Shelving</h1></body></html>`;
const okFetch: PageFetcher = async (url) =>
  url === "https://example.com/" ? page(url, HOME) : page(url, "nope", { status: 404 });

let db: DatabaseSync;
let deps: ScanDeps;
let fetchCalls: number;

beforeEach(() => {
  db = openDb(":memory:");
  fetchCalls = 0;
  deps = { db, queue: new ScanQueue(1, 5), fetchPage: async (u) => { fetchCalls++; return okFetch(u); } };
});

const call = (query: string, headers: Record<string, string> = {}) =>
  handleScan(new Request(`https://siterecon.test/api/scan/stream${query}`, { headers }), deps);

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- event payloads differ per event
async function events(res: Response): Promise<{ event: string; data: any }[]> {
  const text = await res.text();
  return text.split("\n\n").filter((b) => b.startsWith("event:")).map((block) => ({
    event: /^event: (.+)$/m.exec(block)![1],
    data: JSON.parse(/^data: (.+)$/m.exec(block)![1]),
  }));
}
// With TRUST_PROXY unset every request is "untrusted-client".
const IP = "untrusted-client";

describe("handleScan", () => {
  it("rejects a missing or invalid URL with 400 and does not count it", async () => {
    for (const q of ["", "?url=", "?url=https://127.0.0.1", "?url=ftp://example.com"]) {
      const res = await call(q);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBeTruthy();
    }
    expect(fetchCalls).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS c FROM hits").get()).toEqual({ c: 0 });
  });

  it("streams steps and a report, stores it, and counts the scan", async () => {
    const res = await call("?url=example.com");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const evs = await events(res);
    expect(evs[0]).toEqual({ event: "step-start", data: { step: "fetch" } });
    const report = evs.at(-1)!;
    expect(report.event).toBe("report");
    expect(report.data.domain).toBe("example.com");
    expect(db.prepare("SELECT COUNT(*) AS c FROM reports").get()).toEqual({ c: 1 });
    expect(db.prepare("SELECT COUNT(*) AS c FROM hits WHERE bucket = 'global'").get()).toEqual({ c: 1 });
  });

  it("serves a repeat scan from the cache without fetching or counting", async () => {
    await (await call("?url=example.com")).text();
    const before = fetchCalls;
    const evs = await events(await call("?url=https://www.example.com/"));
    expect(evs.map((e) => e.event)).toEqual(["cached", "report"]);
    expect(fetchCalls).toBe(before);
    expect(db.prepare("SELECT COUNT(*) AS c FROM hits WHERE bucket = 'global'").get()).toEqual({ c: 1 });
  });

  it("returns 429 with Retry-After and the reason when a limit is hit", async () => {
    const now = Date.now();
    for (let i = 0; i < 5; i++) commitRateLimit(db, IP, `s${i}.com`, now - i);
    const res = await call("?url=example.com");
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.reason).toBe("per-ip");
    expect(body.retryAfterMs).toBeGreaterThan(0);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(fetchCalls).toBe(0);
  });

  it("returns 503 when the queue is full", async () => {
    deps.queue = new ScanQueue(1, 0);
    await deps.queue.tryEnter();
    const res = await call("?url=example.com");
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/busy/i);
    expect(db.prepare("SELECT COUNT(*) AS c FROM hits").get()).toEqual({ c: 0 });
  });

  it("refunds the scan and explains when the target is not a web page", async () => {
    deps.fetchPage = async (url) => page(url, "%PDF", { contentType: "application/pdf" });
    const evs = await events(await call("?url=example.com"));
    const last = evs.at(-1)!;
    expect(last.event).toBe("error");
    expect(last.data.message).toMatch(/not a web page/);
    // The visitor's own scan is given back. The request to the target really was sent, so the
    // global and per-target hits stay (see review-fixes.test.ts for the full contract).
    expect(db.prepare("SELECT COUNT(*) AS c FROM hits WHERE bucket = ?").get(`ip:${IP}`)).toEqual({ c: 0 });
    expect(peekRateLimit(db, IP, "example.com").allowed).toBe(true);
  });

  it("frees the queue slot after a scan, including a failed one", async () => {
    deps.queue = new ScanQueue(1, 0);
    deps.fetchPage = async () => { throw new Error("down"); };
    await (await call("?url=example.com")).text();
    expect(deps.queue.tryEnter()).not.toBeNull();
  });

  it("stops a scan that exceeds the time ceiling", async () => {
    deps.scanTimeoutMs = 50;
    deps.fetchPage = () => new Promise(() => {}); // never answers
    const evs = await events(await call("?url=example.com"));
    expect(evs.at(-1)).toEqual({ event: "error", data: { message: expect.stringMatching(/took too long/) } });
  });

  it("frees the queue slot when the visitor disconnects mid-scan", async () => {
    deps.queue = new ScanQueue(1, 0);
    deps.fetchPage = () => new Promise(() => {}); // never answers
    const res = await call("?url=example.com");
    const reader = res.body!.getReader();
    await reader.read(); // the first step-start
    await reader.cancel();
    await new Promise((r) => setTimeout(r, 20));
    expect(deps.queue.tryEnter()).not.toBeNull();
  });

  it("adds CORS headers only for allowed origins, on errors too", async () => {
    const ok = await call("?url=", { origin: "https://georgemridun.dev" });
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://georgemridun.dev");
    const no = await call("?url=", { origin: "https://evil.example" });
    expect(no.headers.get("access-control-allow-origin")).toBeNull();
  });
});
