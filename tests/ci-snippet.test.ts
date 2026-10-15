import { describe, it, expect, afterAll, beforeAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { spawn } from "node:child_process";
import { buildFixKit } from "@/lib/fix-kit";
import { snap } from "./helpers/snap";

// The CI workflow in the fix kit is only worth shipping if it works. This takes the real snippet from
// the kit, pulls the script out of it, and runs it with Node against a local server that answers the
// way SiteRecon's scan endpoint does.

function scriptFromKit(): string {
  const kit = buildFixKit(snap("<html><head><title>Acme</title></head><body></body></html>"), [], null);
  const content = kit.find((k) => k.id === "ci-audit")!.content;
  const lines = content.split("\n");
  const start = lines.findIndex((l) => l.includes("<<'JS'"));
  const end = lines.findIndex((l, i) => i > start && l.trim() === "JS");
  expect(start, "the script is a here-document").toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const body = lines.slice(start + 1, end);
  const indent = Math.min(...body.filter((l) => l.trim()).map((l) => l.match(/^ */)![0].length));
  return body.map((l) => l.slice(indent)).join("\n");
}

type Reply = { status: number; headers?: Record<string, string>; body: string };
let server: http.Server;
let base = "";
let reply: Reply = { status: 200, body: "" };
let lastUrl = "";

beforeAll(async () => {
  server = http.createServer((req, res) => {
    lastUrl = req.url ?? "";
    res.writeHead(reply.status, { "content-type": "text/event-stream", ...reply.headers });
    res.end(reply.body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
// Asynchronous on purpose: the fake server below runs in this same process, so a blocking spawn would freeze it.
const run = (min: string) =>
  new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", scriptFromKit()], {
      env: { ...process.env, SITERECON: base, TARGET: "https://acme.example/", MIN_SCORE: min },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill(), 20_000);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });

describe("the CI audit snippet", () => {
  it("passes when the report scores at or above the threshold, and asks for the right address", async () => {
    reply = { status: 200, body: sse("step-start", { step: "fetch" }) + sse("report", { overallScore: 85, aiReadiness: { score: 72 } }) };
    const r = await run("80");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/Overall 85/);
    expect(r.stdout).toMatch(/AI readiness 72/);
    expect(lastUrl).toBe("/api/scan/stream?url=https%3A%2F%2Facme.example%2F");
  });

  it("fails the job when the score is below the threshold", async () => {
    reply = { status: 200, body: sse("report", { overallScore: 61, aiReadiness: { score: 40 } }) };
    const r = await run("80");
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/below/i);
  });

  it("fails clearly when the scan reports an error", async () => {
    reply = { status: 200, body: sse("error", { message: "Could not reach acme.example" }) };
    const r = await run("80");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("Could not reach acme.example");
  });

  it("fails clearly when the server rate limits the audit, and says what it answered", async () => {
    reply = { status: 429, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: "Rate limit reached (visitor). Try again in about 30 minutes." }) };
    const r = await run("80");
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/429/);
    expect(r.stderr).toMatch(/Rate limit reached/);
  });

  it("fails when the stream ends without a report", async () => {
    reply = { status: 200, body: sse("step-start", { step: "fetch" }) };
    const r = await run("80");
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/without a report/);
  });

  it("treats a report with no score as a failure rather than a pass", async () => {
    reply = { status: 200, body: sse("report", { overallScore: null }) };
    expect((await run("80")).status).toBe(1);
  });
});
