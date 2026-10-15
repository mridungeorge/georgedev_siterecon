import { describe, it, expect } from "vitest";
import { readAuthoritySignals } from "@/lib/authority";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const noWait = { retry: { sleep: async () => {}, jitter: () => 1, retries: 0 } };

function fakeFetch(handlers: { opr?: () => Response; wikidata?: () => Response }) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    if (url.includes("openpagerank.com")) return handlers.opr ? handlers.opr() : new Response("", { status: 500 });
    if (url.includes("wikidata.org")) return handlers.wikidata ? handlers.wikidata() : new Response("", { status: 500 });
    return new Response("", { status: 404 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("readAuthoritySignals", () => {
  it("reads the domain rank from Open PageRank with the key in a header, not the address", async () => {
    const f = fakeFetch({ opr: () => json({ status_code: 200, response: [{ domain: "acme.example", page_rank_decimal: 4.37, status_code: 200 }] }) });
    const s = await readAuthoritySignals({ domain: "acme.example", entity: null, apiKey: "opr-key", fetch: f.impl, ...noWait });
    expect(s.domainRank).toBe(4.4);
    const call = f.calls.find((c) => c.url.includes("openpagerank.com"))!;
    expect(call.url).not.toContain("opr-key");
    expect(call.headers["API-OPR"]).toBe("opr-key");
    expect(call.url).toContain("domains%5B%5D=acme.example");
  });

  it("skips Open PageRank without a key, and says the rank was not measured", async () => {
    const f = fakeFetch({});
    const s = await readAuthoritySignals({ domain: "acme.example", entity: null, apiKey: undefined, fetch: f.impl, ...noWait });
    expect(s.domainRank).toBeNull();
    expect(f.calls).toHaveLength(0);
  });

  it("finds the business in Wikidata only when a label matches its name exactly", async () => {
    const hit = fakeFetch({ wikidata: () => json({ search: [{ label: "Acme Corporation" }, { label: "Acme" }] }) });
    expect((await readAuthoritySignals({ domain: "acme.example", entity: "Acme", apiKey: undefined, fetch: hit.impl, ...noWait })).wikidata).toBe(true);
    const near = fakeFetch({ wikidata: () => json({ search: [{ label: "Acme Corporation" }] }) });
    expect((await readAuthoritySignals({ domain: "acme.example", entity: "Acme", apiKey: undefined, fetch: near.impl, ...noWait })).wikidata).toBe(false);
  });

  it("sends the page-supplied name only as an encoded query value to the fixed Wikidata host", async () => {
    const f = fakeFetch({ wikidata: () => json({ search: [] }) });
    await readAuthoritySignals({ domain: "acme.example", entity: "Acme & Co <script>", apiKey: undefined, fetch: f.impl, ...noWait });
    const url = new URL(f.calls[0]!.url);
    expect(url.hostname).toBe("www.wikidata.org");
    expect(url.searchParams.get("search")).toBe("Acme & Co <script>");
  });

  it("returns null for a signal that could not be read, and still returns the others", async () => {
    const f = fakeFetch({ opr: () => new Response("", { status: 500 }), wikidata: () => json({ search: [{ label: "Acme" }] }) });
    const s = await readAuthoritySignals({ domain: "acme.example", entity: "Acme", apiKey: "k", fetch: f.impl, ...noWait });
    expect(s.domainRank).toBeNull();
    expect(s.wikidata).toBe(true);
  });

  it("does not look up a name that is missing or too long to be a business name", async () => {
    const f = fakeFetch({});
    const s = await readAuthoritySignals({ domain: "acme.example", entity: "x".repeat(200), apiKey: undefined, fetch: f.impl, ...noWait });
    expect(s.wikidata).toBeNull();
    expect(f.calls).toHaveLength(0);
  });
});
