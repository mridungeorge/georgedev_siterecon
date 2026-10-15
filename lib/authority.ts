import { fetchJsonWithBackoff, type BackoffOptions } from "@/lib/retry";

// Outside signals that a source is known beyond its own pages. Each is optional and comes from a free
// service: Open PageRank (a free key; a domain's link-based rank from 0 to 10, a stand-in for the
// backlink data a paid API would give) and Wikidata (no key; whether the business has an entry). A
// signal that cannot be read is null, never a guess, and the hosts are fixed, so nothing the audited
// site says decides where a request goes. The site's name is sent only as an encoded query value.

export interface AuthoritySignals {
  /** Open PageRank's decimal rank from 0 to 10, to one place, or null when it was not measured. */
  domainRank: number | null;
  /** Whether Wikidata has an entry with exactly this name, or null when it was not checked. */
  wikidata: boolean | null;
  /** Public Hacker News stories that mention the domain, or null when not read. */
  hackerNews: number | null;
}

export interface AuthorityDeps {
  domain: string;
  /** The site's name as it states it. Untrusted text. */
  entity: string | null;
  apiKey: string | undefined;
  hackerNews?: number | null;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  retry?: BackoffOptions;
}

const MAX_NAME = 80;

export async function readAuthoritySignals(deps: AuthorityDeps): Promise<AuthoritySignals> {
  const { domain, entity, apiKey, signal } = deps;
  const retry = { retries: 1, baseMs: 400, maxMs: 2_000, ...deps.retry };
  const out: AuthoritySignals = { domainRank: null, wikidata: null, hackerNews: deps.hackerNews ?? null };

  if (apiKey) {
    try {
      const url = `https://openpagerank.com/api/v1.0/getPageRank?domains%5B%5D=${encodeURIComponent(domain)}`;
      const body = (await fetchJsonWithBackoff(url, {
        fetch: deps.fetch, init: { headers: { "API-OPR": apiKey } }, timeoutMs: 10_000, signal, ...retry,
      })) as { response?: { page_rank_decimal?: unknown }[] };
      const rank = body.response?.[0]?.page_rank_decimal;
      if (typeof rank === "number" && Number.isFinite(rank) && rank >= 0 && rank <= 10) out.domainRank = Math.round(rank * 10) / 10;
    } catch {
      if (signal?.aborted) throw new Error("The scan was cancelled.");
    }
  }

  if (entity && entity.length <= MAX_NAME && /\S/.test(entity)) {
    try {
      const url = `https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&language=en&limit=5&search=${encodeURIComponent(entity)}`;
      const body = (await fetchJsonWithBackoff(url, { fetch: deps.fetch, timeoutMs: 8_000, signal, ...retry })) as { search?: { label?: unknown }[] };
      const wanted = entity.trim().toLowerCase();
      out.wikidata = (body.search ?? []).some((r) => typeof r.label === "string" && r.label.trim().toLowerCase() === wanted);
    } catch {
      if (signal?.aborted) throw new Error("The scan was cancelled.");
    }
  }
  return out;
}

/** Whether the signals show the source is known beyond its own pages. Null when none was measured. */
export function isKnownSource(s: AuthoritySignals): boolean | null {
  // Hacker News is evidence only when it is positive: most good small sites are not discussed there, so
  // a count of zero alone is not a reason to call a source unknown.
  const strongMeasured = s.domainRank !== null || s.wikidata !== null;
  const known = (s.domainRank ?? 0) >= 3 || s.wikidata === true || (s.hackerNews ?? 0) >= 3;
  if (!strongMeasured) return known ? true : null;
  return known;
}
