import type { DatabaseSync } from "node:sqlite";
import { quotaLimits, tryConsumeQuota } from "@/lib/quota";
import { TransientError, withBackoff, type BackoffOptions } from "@/lib/retry";

/** Returns the URLs of web search results for a query. */
export type SearchFn = (query: string, signal?: AbortSignal) => Promise<string[]>;

export interface TavilyOptions {
  apiKey: string | undefined;
  db: DatabaseSync;
  fetch?: typeof fetch;
  env?: Record<string, string | undefined>;
  retry?: BackoffOptions;
}

/**
 * Tavily's free plan (1,000 credits a month, no card needed) as an optional way to find
 * competitors. Without a key, or once the daily guard is spent, it quietly returns nothing
 * and the AI-suggested competitors are used alone. Sign up without a card, so it can only stop.
 */
export function createTavilySearch(opts: TavilyOptions): SearchFn {
  const doFetch = opts.fetch ?? fetch;
  return async (query, signal) => {
    if (!opts.apiKey) return [];
    if (!tryConsumeQuota(opts.db, "search", Date.now(), quotaLimits(opts.env ?? process.env))) return [];
    try {
      // One retry on a busy answer (429 or 5xx). A refused key is not retried, so it still logs at once.
      const res = await withBackoff(async () => {
        const timeout = AbortSignal.timeout(15_000);
        const answer = await doFetch("https://api.tavily.com/search", {
          method: "POST",
          headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ query, max_results: 8, search_depth: "basic" }),
          signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
        });
        if (answer.status >= 500 && answer.status <= 599) throw new TransientError(`HTTP ${answer.status}`, answer.status);
        return answer;
      }, { retries: 1, baseMs: 400, maxMs: 2_000, signal, ...opts.retry }).catch((err) => {
        if (err instanceof TransientError) return { ok: false, status: err.status ?? 500 } as Response;
        throw err;
      });
      if (!res.ok) {
        // For the person running the server: a refused key would otherwise look exactly like "no results".
        console.warn(`[siterecon] Tavily search was refused (HTTP ${res.status}). Check TAVILY_API_KEY and the plan's monthly credits.`);
        return [];
      }
      const body = (await res.json()) as { results?: { url?: unknown }[] };
      return (body.results ?? []).map((r) => r.url).filter((u): u is string => typeof u === "string");
    } catch {
      if (signal?.aborted) throw new Error("The scan was cancelled.");
      return [];
    }
  };
}
