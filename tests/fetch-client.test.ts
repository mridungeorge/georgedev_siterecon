import { describe, it, expect } from "vitest";
import { createFetchClient } from "@/lib/fetch-client";
import { countHackerNewsMentions } from "@/lib/mentions";
import { createTavilySearch } from "@/lib/search/tavily";
import { openDb } from "@/lib/db";

type Call = { url: string; method: string; headers: Headers; body: unknown };
function fake(responder: (call: Call) => { status?: number; body?: unknown } | Error) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = { url: String(input), method: init?.method ?? "GET", headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const r = responder(call);
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
  }) as typeof fetch;
  return { impl, calls };
}
const link = { platform: "youtube" as const, url: "https://www.youtube.com/@acme", handle: "@acme", kind: "profile" as const };

describe("createFetchClient", () => {
  it("sends the shared secret and the profile to read, and returns the validated answer", async () => {
    const f = fake(() => ({ body: { status: "found", title: "Acme", lastActivityAt: "2026-09-01T00:00:00Z" } }));
    const client = createFetchClient({ baseUrl: "http://127.0.0.1:8787/", secret: "s3cret", fetch: f.impl });
    const read = await client.readProfile(link);
    expect(read).toEqual({ status: "found", title: "Acme", lastActivityAt: "2026-09-01T00:00:00Z" });
    expect(f.calls[0].url).toBe("http://127.0.0.1:8787/social/read");
    expect(f.calls[0].method).toBe("POST");
    expect(f.calls[0].headers.get("x-siterecon-secret")).toBe("s3cret");
    expect(f.calls[0].body).toEqual({ url: link.url, platform: "youtube" });
  });
  it.each([
    ["an HTTP error", () => ({ status: 500 })],
    ["a connection failure", () => new Error("ECONNREFUSED")],
    ["an answer of the wrong shape", () => ({ body: { status: "weird" } })],
  ])("turns %s into an unreadable profile instead of throwing", async (_, responder) => {
    const client = createFetchClient({ baseUrl: "http://x", secret: "s", fetch: fake(responder).impl });
    const read = await client.readProfile(link);
    expect(read.status).toBe("unreadable");
  });
  it("reports render results and treats failures as skipped", async () => {
    const ok = createFetchClient({ baseUrl: "http://x", secret: "s", fetch: fake(() => ({ body: { status: "ok", words: 412, mobileOverflow: true } })).impl });
    expect(await ok.render("https://acme.example/")).toEqual({ status: "ok", words: 412, mobileOverflow: true });
    const bad = createFetchClient({ baseUrl: "http://x", secret: "s", fetch: fake(() => new Error("down")).impl });
    expect(await bad.render("https://acme.example/")).toMatchObject({ status: "skipped" });
  });
  it("health returns false when the service is down or unhealthy", async () => {
    expect(await createFetchClient({ baseUrl: "http://x", secret: "s", fetch: fake(() => ({ body: { ok: true } })).impl }).healthy()).toBe(true);
    expect(await createFetchClient({ baseUrl: "http://x", secret: "s", fetch: fake(() => ({ status: 503 })).impl }).healthy()).toBe(false);
    expect(await createFetchClient({ baseUrl: "http://x", secret: "s", fetch: fake(() => new Error("down")).impl }).healthy()).toBe(false);
  });
});

describe("countHackerNewsMentions", () => {
  it("returns the number of stories that mention the domain", async () => {
    const f = fake(() => ({ body: { nbHits: 7 } }));
    expect(await countHackerNewsMentions("acme.example", f.impl)).toBe(7);
    expect(f.calls[0].url).toContain("hn.algolia.com/api/v1/search");
    expect(f.calls[0].url).toContain("query=acme.example");
  });
  it.each([[{ status: 500 }], [new Error("down")], [{ body: { nbHits: "many" } }]])("returns null on failure %#", async (r) => {
    expect(await countHackerNewsMentions("acme.example", fake(() => r as never).impl)).toBeNull();
  });
});

describe("createTavilySearch", () => {
  it("returns result URLs, sends the key as a bearer token, and counts quota", async () => {
    const f = fake(() => ({ body: { results: [{ url: "https://rival.example/a" }, { url: "https://other.example/" }, { nope: 1 }] } }));
    const db = openDb(":memory:");
    const search = createTavilySearch({ apiKey: "tv-key", db, fetch: f.impl });
    expect(await search("alternatives to acme.example")).toEqual(["https://rival.example/a", "https://other.example/"]);
    expect(f.calls[0].headers.get("authorization")).toBe("Bearer tv-key");
    expect((f.calls[0].body as { query: string }).query).toBe("alternatives to acme.example");
  });
  it("returns nothing without calling out when there is no key or the daily budget is spent", async () => {
    const f = fake(() => ({ body: { results: [{ url: "https://r.example/" }] } }));
    expect(await createTavilySearch({ apiKey: undefined, db: openDb(":memory:"), fetch: f.impl })("q")).toEqual([]);
    const db = openDb(":memory:");
    const search = createTavilySearch({ apiKey: "k", db, fetch: f.impl, env: { QUOTA_SEARCH_DAY: "1" } });
    await search("q");
    expect(await search("q")).toEqual([]);
    expect(f.calls).toHaveLength(1);
  });
  it("returns nothing when the request fails", async () => {
    const search = createTavilySearch({ apiKey: "k", db: openDb(":memory:"), fetch: fake(() => ({ status: 429 })).impl });
    expect(await search("q")).toEqual([]);
  });
});
