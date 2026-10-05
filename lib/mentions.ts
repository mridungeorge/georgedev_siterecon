/**
 * How many Hacker News stories mention the domain. Uses HN's free public search API, a fixed
 * trusted host, so no site-controlled address is ever fetched. Null when it cannot be read.
 * Reddit is left out: its public API now needs authentication.
 */
export async function countHackerNewsMentions(domain: string, doFetch: typeof fetch = fetch, signal?: AbortSignal): Promise<number | null> {
  try {
    const timeout = AbortSignal.timeout(8_000);
    const res = await doFetch(`https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(domain)}&tags=story&hitsPerPage=1`, {
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { nbHits?: unknown };
    return typeof body.nbHits === "number" && Number.isInteger(body.nbHits) && body.nbHits >= 0 ? body.nbHits : null;
  } catch {
    return null;
  }
}
