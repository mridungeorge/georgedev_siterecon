import { describe, it, expect, beforeEach } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "@/lib/db";
import { createLlmClient, extractJson, LlmUnavailableError } from "@/lib/llm/router";

let db: DatabaseSync;
beforeEach(() => { db = openDb(":memory:"); });

type Call = { url: string; body: Record<string, unknown>; auth: string | null };

function fakeFetch(plan: Record<string, { status: number; content?: string }>) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ url, body, auth: new Headers(init?.headers).get("authorization") });
    const key = url.includes("nvidia") ? "nim" : "gemini";
    const r = plan[key] ?? { status: 500 };
    return new Response(
      JSON.stringify(r.status === 200 ? { choices: [{ message: { content: r.content } }], usage: { prompt_tokens: 3, completion_tokens: 4 } } : { error: "x" }),
      { status: r.status },
    );
  }) as typeof fetch;
  return { impl, calls };
}

const both = { NVIDIA_NIM_API_KEY: "nim-key", GEMINI_API_KEY: "gem-key" };
const ask = { system: "sys", user: "usr" };

describe("createLlmClient", () => {
  it("uses NVIDIA NIM first and reports which provider answered", async () => {
    const f = fakeFetch({ nim: { status: 200, content: "from nim" }, gemini: { status: 200, content: "from gemini" } });
    const llm = createLlmClient({ db, env: both, fetch: f.impl });
    const res = await llm(ask);
    expect(res).toMatchObject({ content: "from nim", provider: "nim" });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].auth).toBe("Bearer nim-key");
  });

  it("falls over to Gemini when NIM errors or is rate limited", async () => {
    for (const status of [429, 500]) {
      const f = fakeFetch({ nim: { status }, gemini: { status: 200, content: "from gemini" } });
      const res = await createLlmClient({ db: openDb(":memory:"), env: both, fetch: f.impl })(ask);
      expect(res.provider).toBe("gemini");
      expect(f.calls.map((c) => c.url.includes("nvidia"))).toEqual([true, false]);
    }
  });

  it("LLM_PRIMARY=gemini tries Gemini first", async () => {
    const f = fakeFetch({ nim: { status: 200, content: "n" }, gemini: { status: 200, content: "g" } });
    const res = await createLlmClient({ db, env: { ...both, LLM_PRIMARY: "gemini" }, fetch: f.impl })(ask);
    expect(res.provider).toBe("gemini");
    expect(f.calls).toHaveLength(1);
  });

  it("skips a provider with no key", async () => {
    const f = fakeFetch({ gemini: { status: 200, content: "g" } });
    const res = await createLlmClient({ db, env: { GEMINI_API_KEY: "k" }, fetch: f.impl })(ask);
    expect(res.provider).toBe("gemini");
    expect(f.calls).toHaveLength(1);
  });

  it("throws LlmUnavailableError when no provider is configured", async () => {
    const f = fakeFetch({});
    await expect(createLlmClient({ db, env: {}, fetch: f.impl })(ask)).rejects.toBeInstanceOf(LlmUnavailableError);
    expect(f.calls).toHaveLength(0);
  });

  it("throws LlmUnavailableError when every provider fails", async () => {
    const f = fakeFetch({ nim: { status: 500 }, gemini: { status: 500 } });
    await expect(createLlmClient({ db, env: both, fetch: f.impl })(ask)).rejects.toBeInstanceOf(LlmUnavailableError);
  });

  it("refuses without calling anyone once the daily LLM budget is used up", async () => {
    const f = fakeFetch({ nim: { status: 200, content: "ok" } });
    const llm = createLlmClient({ db, env: { ...both, QUOTA_LLM_DAY: "2" }, fetch: f.impl });
    await llm(ask);
    await llm(ask);
    await expect(llm(ask)).rejects.toThrow(/daily/i);
    expect(f.calls).toHaveLength(2);
  });

  it("asks for JSON output when jsonOnly is set", async () => {
    const f = fakeFetch({ nim: { status: 200, content: "{}" } });
    await createLlmClient({ db, env: both, fetch: f.impl })({ ...ask, jsonOnly: true });
    expect(f.calls[0].body.response_format).toEqual({ type: "json_object" });
  });
});

describe("extractJson", () => {
  it("parses plain JSON, fenced JSON and JSON surrounded by prose", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('```json\n{"a":[1,2]}\n```')).toEqual({ a: [1, 2] });
    expect(extractJson('Sure! Here you go: {"a":{"b":"}"}} hope that helps')).toEqual({ a: { b: "}" } });
  });
  it("throws when there is no JSON", () => {
    expect(() => extractJson("no json here")).toThrow();
  });
});
