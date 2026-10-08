import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readScorecards } from "@/lib/accuracy";
import { logScanRun, resetMlflowCache } from "@/lib/observability/mlflow";
import { handleScan } from "@/lib/scan-handler";
import { ScanQueue } from "@/lib/scan-queue";
import { openDb } from "@/lib/db";
import type { Report } from "@/lib/pipeline/schemas";
import { page } from "./helpers/snap";

describe("readScorecards", () => {
  const dirs: string[] = [];
  const make = (files: Record<string, unknown>) => {
    const dir = mkdtempSync(join(tmpdir(), "acc-"));
    dirs.push(dir);
    mkdirSync(join(dir, "eval"));
    for (const [name, value] of Object.entries(files)) writeFileSync(join(dir, "eval", name), typeof value === "string" ? value : JSON.stringify(value));
    return dir;
  };
  it("reads both scorecards", () => {
    const dir = make({
      "scorecard.json": { fixtures: 9, expectedFindings: 48, foundExpected: 48, recall: 1, falsePositives: 0, evidenceValid: true, deterministic: true, failures: [], ranOn: "2026-10-05", recallFloor: 0.95 },
      "adversarial-scorecard.json": { total: 10, passed: 10, failed: [], cases: [], ranOn: "2026-10-05" },
    });
    const r = readScorecards(dir);
    expect(r.eval?.fixtures).toBe(9);
    expect(r.adversarial?.passed).toBe(10);
    rmSync(dir, { recursive: true, force: true });
  });
  it("returns nulls, not errors, when the files are missing or corrupt", () => {
    const missing = readScorecards(join(tmpdir(), "does-not-exist-siterecon"));
    expect(missing).toEqual({ eval: null, adversarial: null });
    const dir = make({ "scorecard.json": "{not json", "adversarial-scorecard.json": { nope: true } });
    expect(readScorecards(dir)).toEqual({ eval: null, adversarial: null });
    rmSync(dir, { recursive: true, force: true });
  });
});

const REPORT = {
  id: "r1", url: "https://acme.example/", domain: "acme.example", createdAt: "2026-10-05T00:00:00.000Z", overallScore: 61,
  modules: [{ module: "technical", status: "ok", score: 57, findings: [], passed: [], couldntCheck: [] }, { module: "performance", status: "failed", score: null, findings: [], passed: [], couldntCheck: [] }],
  topFixes: [], fixPrompt: "p", couldntCheck: [{ what: "x", why: "y" }], pagesScanned: ["https://acme.example/"], injectionFlags: 2, ideas: [], social: null, competitors: null, summary: null, fixKit: [],
} as unknown as Report;

type Call = { url: string; method: string; body: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
function mlflow(over: { experimentExists?: boolean; fail?: string } = {}) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (over.fail && url.includes(over.fail)) return new Response("{}", { status: 500 });
    if (url.includes("experiments/get-by-name")) {
      return over.experimentExists === false ? new Response('{"error_code":"RESOURCE_DOES_NOT_EXIST"}', { status: 404 }) : new Response('{"experiment":{"experiment_id":"7"}}');
    }
    if (url.includes("experiments/create")) return new Response('{"experiment_id":"9"}');
    if (url.includes("runs/create")) return new Response('{"run":{"info":{"run_id":"run-1"}}}');
    return new Response("{}");
  }) as typeof fetch;
  return { impl, calls };
}

describe("logScanRun", () => {
  beforeEach(() => resetMlflowCache());

  it("creates a run in the siterecon experiment with the scan's metrics", async () => {
    const m = mlflow();
    expect(await logScanRun({ baseUrl: "http://mlflow:5000/", fetch: m.impl }, REPORT, 12345)).toBe(true);
    const batch = m.calls.find((c) => c.url.endsWith("runs/log-batch"))!;
    expect(batch.body.run_id).toBe("run-1");
    const metrics = Object.fromEntries(batch.body.metrics.map((x: { key: string; value: number }) => [x.key, x.value]));
    expect(metrics).toMatchObject({ overall_score: 61, duration_ms: 12345, injection_flags: 2, couldnt_check: 1, pages_scanned: 1, score_technical: 57 });
    expect(metrics).not.toHaveProperty("score_performance"); // no score, no metric
    expect(Object.fromEntries(batch.body.params.map((x: { key: string; value: string }) => [x.key, x.value]))).toEqual({ domain: "acme.example" });
    expect(m.calls.at(-1)!.url).toMatch(/runs\/update$/);
    expect(m.calls.at(-1)!.body.status).toBe("FINISHED");
  });

  it("creates the experiment when it does not exist yet, and looks it up only once", async () => {
    const m = mlflow({ experimentExists: false });
    await logScanRun({ baseUrl: "http://mlflow:5000", fetch: m.impl }, REPORT, 1);
    await logScanRun({ baseUrl: "http://mlflow:5000", fetch: m.impl }, REPORT, 1);
    expect(m.calls.filter((c) => c.url.includes("experiments/create"))).toHaveLength(1);
    expect(m.calls.filter((c) => c.url.includes("get-by-name"))).toHaveLength(1);
    expect(m.calls.find((c) => c.url.includes("runs/create"))!.body.experiment_id).toBe("9");
  });

  it.each(["runs/create", "runs/log-batch", "experiments/get-by-name"])("returns false instead of throwing when %s fails", async (fail) => {
    expect(await logScanRun({ baseUrl: "http://mlflow:5000", fetch: mlflow({ fail }).impl }, REPORT, 1)).toBe(false);
  });

  it("returns false when MLflow is unreachable", async () => {
    const down = (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch;
    expect(await logScanRun({ baseUrl: "http://mlflow:5000", fetch: down }, REPORT, 1)).toBe(false);
  });
});

describe("scan handler logging", () => {
  const HOME = `<html lang="en"><head><title>Acme Storage shelving</title></head><body><h1>Shelving</h1></body></html>`;
  const fetchPage = async (url: string) => (url === "https://example.com/" ? page(url, HOME) : page(url, "nope", { status: 404 }));
  const run = (logRun: (r: Report, ms: number) => Promise<unknown>) =>
    handleScan(new Request("https://siterecon.test/api/scan/stream?url=example.com"), { db: openDb(":memory:"), queue: new ScanQueue(1, 1), fetchPage, logRun }).then((r) => r.text());

  it("logs each finished scan once, with its duration", async () => {
    const seen: { id: string; ms: number }[] = [];
    const text = await run(async (r, ms) => { seen.push({ id: r.id, ms }); });
    expect(text).toMatch(/event: report/);
    expect(seen).toHaveLength(1);
    expect(seen[0].ms).toBeGreaterThanOrEqual(0);
  });

  it("a logging failure never affects the scan", async () => {
    const text = await run(async () => { throw new Error("mlflow down"); });
    expect(text).toMatch(/event: report/);
    expect(text).not.toMatch(/event: error/);
  });
});
