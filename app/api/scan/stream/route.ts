import { handleScan } from "@/lib/scan-handler";
import { getDb } from "@/lib/db";
import { safeFetch } from "@/lib/safe-fetch";
import { ScanQueue } from "@/lib/scan-queue";
import { createLlmClient } from "@/lib/llm/router";
import { tryConsumeQuota } from "@/lib/quota";
import { createFetchClient } from "@/lib/fetch-client";
import { createInstagramReader } from "@/lib/social/instagram";
import { createTavilySearch } from "@/lib/search/tavily";
import { countHackerNewsMentions } from "@/lib/mentions";
import { fetchJsonWithBackoff } from "@/lib/retry";
import { readAuthoritySignals } from "@/lib/authority";
import { logScanRun } from "@/lib/observability/mlflow";
import type { PageSpeedDeps } from "@/lib/checks/performance";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

// One queue for the whole process: 1 active scan, 5 waiting (spec section 7).
const queue = new ScanQueue(1, 5);

export function GET(req: Request) {
  const db = getDb();
  // Every outside service is optional. Without its key or address, that part of the report says
  // "couldn't check" and the rest of the audit still runs.
  const pagespeed: PageSpeedDeps = {
    apiKey: process.env.PAGESPEED_API_KEY,
    quotaOk: () => tryConsumeQuota(db, "pagespeed"),
    // PageSpeed answers 429 and 5xx when busy, so one retry with a short wait is worth the few seconds.
    fetchJson: (url, signal) => fetchJsonWithBackoff(url, { timeoutMs: 60_000, signal, retries: 1, baseMs: 800, maxMs: 4_000 }),
  };
  const fetchClient = process.env.FETCH_SERVICE_URL && process.env.FETCH_SERVICE_SECRET
    ? createFetchClient({ baseUrl: process.env.FETCH_SERVICE_URL, secret: process.env.FETCH_SERVICE_SECRET })
    : null;
  // Optional: Instagram business and creator accounts through Meta's Graph API, using the access token of
  // the owner's connected professional account. Without both values Instagram is read the old way.
  const instagram = process.env.META_IG_USER_ID && process.env.META_ACCESS_TOKEN
    ? createInstagramReader({
        userId: process.env.META_IG_USER_ID,
        token: process.env.META_ACCESS_TOKEN,
        quotaOk: () => tryConsumeQuota(db, "instagram"),
        fetchJson: async (url, signal) => {
          const timeout = AbortSignal.timeout(20_000);
          const res = await fetch(url, { signal: signal ? AbortSignal.any([timeout, signal]) : timeout });
          return { status: res.status, body: await res.json().catch(() => null) };
        },
      })
    : null;
  return handleScan(req, {
    db,
    queue,
    fetchPage: (url, signal) => safeFetch(url, { signal }),
    llm: createLlmClient({ db }),
    pagespeed,
    fetchClient,
    instagram,
    search: createTavilySearch({ apiKey: process.env.TAVILY_API_KEY, db }),
    mentions: (domain, signal) => countHackerNewsMentions(domain, fetch, signal),
    // Open PageRank (needs a free key) and Wikidata (no key), behind a daily guard of their own.
    authority: async (input) =>
      tryConsumeQuota(db, "authority")
        ? readAuthoritySignals({ ...input, apiKey: process.env.OPENPAGERANK_API_KEY })
        : { domainRank: null, wikidata: null, hackerNews: input.hackerNews },
    logRun: process.env.MLFLOW_URL ? (report, ms) => logScanRun({ baseUrl: process.env.MLFLOW_URL as string }, report, ms) : null,
  });
}
