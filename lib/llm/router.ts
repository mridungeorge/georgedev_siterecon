import type { DatabaseSync } from "node:sqlite";
import { quotaLimits, tryConsumeQuota } from "../quota";

// Model router (spec section 7), after RepoRecon's lib/llm/router.ts: NVIDIA NIM's free tier
// first, Gemini's free tier as the fallback, reorderable with LLM_PRIMARY. RepoRecon's Ollama
// fallback is left out because the VM has no room for a local model.

export class LlmUnavailableError extends Error {}

export interface LlmCallOptions {
  system: string;
  user: string;
  maxTokens?: number;
  jsonOnly?: boolean;
  signal?: AbortSignal;
}

export interface LlmResult {
  content: string;
  provider: "nim" | "gemini";
  model: string;
}

export type LlmClient = (opts: LlmCallOptions) => Promise<LlmResult>;

export interface LlmDeps {
  db: DatabaseSync;
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  now?: () => number;
}

interface Provider {
  name: "nim" | "gemini";
  baseUrl: string;
  apiKey: string | undefined;
  model: string;
}

function providers(env: Record<string, string | undefined>): Provider[] {
  const list: Provider[] = [
    {
      name: "nim",
      baseUrl: env.NVIDIA_NIM_BASE_URL ?? "https://integrate.api.nvidia.com/v1",
      apiKey: env.NVIDIA_NIM_API_KEY,
      model: env.NVIDIA_NIM_MODEL ?? "meta/llama-3.2-11b-vision-instruct",
    },
    {
      name: "gemini",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      apiKey: env.GEMINI_API_KEY,
      model: env.GEMINI_MODEL ?? "gemini-2.5-flash-lite",
    },
  ];
  const primary = (env.LLM_PRIMARY ?? "nim").toLowerCase();
  return list.filter((p) => p.apiKey).sort((a, b) => (a.name === primary ? -1 : b.name === primary ? 1 : 0));
}

export function createLlmClient(deps: LlmDeps): LlmClient {
  const env = deps.env ?? process.env;
  const doFetch = deps.fetch ?? fetch;

  return async (opts) => {
    const available = providers(env);
    if (available.length === 0) throw new LlmUnavailableError("No AI provider is configured.");
    if (!tryConsumeQuota(deps.db, "llm", (deps.now ?? Date.now)(), quotaLimits(env))) {
      throw new LlmUnavailableError("The daily AI review budget has been used up. It resets within 24 hours.");
    }

    const failures: string[] = [];
    for (const provider of available) {
      try {
        const timeout = AbortSignal.timeout(60_000);
        const res = await doFetch(`${provider.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${provider.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: provider.model,
            messages: [
              { role: "system", content: opts.system },
              { role: "user", content: opts.user },
            ],
            max_tokens: opts.maxTokens ?? 1500,
            temperature: 0.2,
            ...(opts.jsonOnly ? { response_format: { type: "json_object" } } : {}),
          }),
          signal: opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout,
        });
        if (!res.ok) {
          failures.push(`${provider.name} returned HTTP ${res.status}`);
          continue;
        }
        const data = await res.json();
        const content = data?.choices?.[0]?.message?.content;
        if (typeof content !== "string" || content.trim() === "") {
          failures.push(`${provider.name} returned an empty answer`);
          continue;
        }
        return { content, provider: provider.name, model: provider.model };
      } catch (err) {
        if (opts.signal?.aborted) throw err; // the scan was cancelled: stop, do not try the next provider
        failures.push(`${provider.name} failed (${err instanceof Error ? err.message : "unknown error"})`);
      }
    }
    throw new LlmUnavailableError(`All AI providers failed: ${failures.join("; ")}`);
  };
}

/** Pulls the first JSON value out of a model reply, tolerating code fences and surrounding prose. */
export function extractJson<T = unknown>(content: string): T {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : content;
  const start = raw.search(/[[{]/);
  if (start === -1) throw new Error("no JSON found in the AI response");

  const closer = raw[start] === "{" ? "}" : "]";
  const opener = raw[start];
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === opener) depth++;
    else if (ch === closer && --depth === 0) return JSON.parse(raw.slice(start, i + 1)) as T;
  }
  throw new Error("the AI response contained incomplete JSON");
}

const MAX_REPLY_CHARS = 20_000;
const MAX_RESTARTS = 20;

/** The index of the bracket that closes the one at `start`, ignoring brackets inside strings, or -1. */
function closingIndex(raw: string, start: number): number {
  const opener = raw[start];
  const closer = opener === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === opener) depth++;
    else if (ch === closer && --depth === 0) return i;
  }
  return -1;
}

/**
 * Every top-level JSON value in a model reply, in order. Models sometimes answer {"ideas":[a]}
 * {"ideas":[b]} one object per item instead of one object holding the list, and reading only the first
 * throws the rest away without an error. A fragment that does not parse is skipped, and the work spent
 * on hostile input (thousands of unclosed brackets) is bounded by a cap on the reply size and on restarts.
 */
export function extractAllJson(content: string, max = 50): unknown[] {
  const raw = content.slice(0, MAX_REPLY_CHARS).replace(/```(?:json)?/gi, " ");
  const values: unknown[] = [];
  const opener = /[[{]/g;
  let restarts = 0;
  let sawOpener = false;
  let pos = 0;
  while (values.length < max) {
    opener.lastIndex = pos;
    const m = opener.exec(raw);
    if (!m) break;
    sawOpener = true;
    const end = closingIndex(raw, m.index);
    if (end !== -1) {
      try {
        values.push(JSON.parse(raw.slice(m.index, end + 1)));
        pos = end + 1;
        continue;
      } catch {
        // balanced but not valid JSON: fall through and look inside it
      }
    }
    if (++restarts > MAX_RESTARTS) break;
    pos = m.index + 1;
  }
  if (values.length === 0) throw new Error(sawOpener ? "the AI response contained incomplete JSON" : "no JSON found in the AI response");
  return values;
}

/** The lists found under `key` in every object of `values`, joined in order. */
export function mergeLists(values: unknown[], key: string): unknown[] {
  return values.flatMap((v) => {
    const list = typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>)[key] : undefined;
    return Array.isArray(list) ? list : [];
  });
}

/** The list under `key` from a reply that may hold one object or several. Throws when no object has one. */
export function listFromReply(content: string, key: string): unknown[] {
  const values = extractAllJson(content);
  const has = values.some((v) => typeof v === "object" && v !== null && !Array.isArray(v) && Array.isArray((v as Record<string, unknown>)[key]));
  if (!has) throw new Error("the AI returned an answer in an unexpected format");
  return mergeLists(values, key);
}
