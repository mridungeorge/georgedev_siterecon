import { fetchJsonWithBackoff, type BackoffOptions } from "@/lib/retry";

/**
 * How many Hacker News stories mention the domain. Uses HN's free public search API, a fixed
 * trusted host, so no site-controlled address is ever fetched. Null when it cannot be read.
 * Reddit is left out: its public API now needs authentication.
 */
export async function countHackerNewsMentions(
  domain: string,
  doFetch: typeof fetch = fetch,
  signal?: AbortSignal,
  retry?: BackoffOptions,
): Promise<number | null> {
  try {
    const body = (await fetchJsonWithBackoff(`https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(domain)}&tags=story&hitsPerPage=1`, {
      fetch: doFetch, timeoutMs: 8_000, signal, retries: 1, baseMs: 400, maxMs: 2_000, ...retry,
    })) as { nbHits?: unknown };
    return typeof body.nbHits === "number" && Number.isInteger(body.nbHits) && body.nbHits >= 0 ? body.nbHits : null;
  } catch {
    return null;
  }
}
