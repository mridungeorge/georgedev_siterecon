import { describe, it, expect } from "vitest";
import { withBackoff, TransientError, isTransientStatus, fetchJsonWithBackoff } from "@/lib/retry";

const noSleep = { sleep: async () => {}, jitter: () => 1 };

describe("isTransientStatus", () => {
  it.each([[408, true], [425, true], [429, true], [500, true], [503, true], [400, false], [401, false], [403, false], [404, false], [200, false]])(
    "status %i is %s",
    (status, expected) => expect(isTransientStatus(status)).toBe(expected),
  );
});

describe("withBackoff", () => {
  it("returns the first success without waiting", async () => {
    const waits: number[] = [];
    const r = await withBackoff(async () => "ok", { sleep: async (ms) => void waits.push(ms), jitter: () => 1 });
    expect(r).toBe("ok");
    expect(waits).toEqual([]);
  });

  it("retries a transient failure with exponentially growing waits and then succeeds", async () => {
    const waits: number[] = [];
    let calls = 0;
    const r = await withBackoff(
      async () => {
        calls += 1;
        if (calls < 3) throw new TransientError("busy", 503);
        return "done";
      },
      { retries: 3, baseMs: 100, factor: 2, sleep: async (ms) => void waits.push(ms), jitter: () => 1 },
    );
    expect(r).toBe("done");
    expect(calls).toBe(3);
    expect(waits).toEqual([100, 200]);
  });

  it("gives up after the retries and throws the last error", async () => {
    let calls = 0;
    await expect(
      withBackoff(async () => { calls += 1; throw new TransientError("still busy", 503); }, { retries: 2, ...noSleep }),
    ).rejects.toThrow("still busy");
    expect(calls).toBe(3);
  });

  it("does not retry an error that is not transient", async () => {
    let calls = 0;
    await expect(withBackoff(async () => { calls += 1; throw new Error("bad key"); }, { retries: 3, ...noSleep })).rejects.toThrow("bad key");
    expect(calls).toBe(1);
  });

  it("caps each wait", async () => {
    const waits: number[] = [];
    let calls = 0;
    await withBackoff(
      async () => { calls += 1; if (calls < 4) throw new TransientError("x", 500); return 1; },
      { retries: 3, baseMs: 1000, factor: 10, maxMs: 1500, sleep: async (ms) => void waits.push(ms), jitter: () => 1 },
    );
    expect(waits).toEqual([1000, 1500, 1500]);
  });

  it("honours Retry-After, within the cap", async () => {
    const waits: number[] = [];
    let calls = 0;
    await withBackoff(
      async () => { calls += 1; if (calls === 1) throw new TransientError("slow down", 429, 2000); return 1; },
      { retries: 1, baseMs: 100, maxMs: 5000, sleep: async (ms) => void waits.push(ms), jitter: () => 1 },
    );
    expect(waits).toEqual([2000]);
  });

  it("stops at once when the scan is cancelled", async () => {
    const controller = new AbortController();
    let calls = 0;
    await expect(
      withBackoff(
        async () => { calls += 1; controller.abort(); throw new TransientError("x", 503); },
        { retries: 3, signal: controller.signal, sleep: async () => {}, jitter: () => 1 },
      ),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });
});

describe("fetchJsonWithBackoff", () => {
  const res = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
    ({ ok: status >= 200 && status < 300, status, headers: { get: (k: string) => headers[k.toLowerCase()] ?? null }, json: async () => body }) as unknown as Response;

  it("retries a 429 and a 503 and returns the body", async () => {
    const answers = [res(429, {}, { "retry-after": "1" }), res(503), res(200, { ok: true })];
    let i = 0;
    const body = await fetchJsonWithBackoff("https://api.example/", { fetch: async () => answers[i++]!, ...noSleep, retries: 3 });
    expect(body).toEqual({ ok: true });
    expect(i).toBe(3);
  });

  it("fails straight away on a 400", async () => {
    let i = 0;
    await expect(fetchJsonWithBackoff("https://api.example/", { fetch: async () => { i += 1; return res(400); }, ...noSleep, retries: 3 })).rejects.toThrow(/HTTP 400/);
    expect(i).toBe(1);
  });

  it("retries a network failure", async () => {
    let i = 0;
    const body = await fetchJsonWithBackoff("https://api.example/", {
      fetch: async () => { i += 1; if (i === 1) throw new TypeError("fetch failed"); return res(200, { n: 1 }); }, ...noSleep, retries: 2,
    });
    expect(body).toEqual({ n: 1 });
  });
});
