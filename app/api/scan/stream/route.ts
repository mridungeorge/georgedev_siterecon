import { handleScan } from "@/lib/scan-handler";
import { getDb } from "@/lib/db";
import { safeFetch } from "@/lib/safe-fetch";
import { ScanQueue } from "@/lib/scan-queue";
import { createLlmClient } from "@/lib/llm/router";
import { tryConsumeQuota } from "@/lib/quota";
import { createFetchClient } from "@/lib/fetch-client";
import { createTavilySearch } from "@/lib/search/tavily";
import { countHackerNewsMentions } from "@/lib/mentions";
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
    fetchJson: async (url, signal) => {
      const timeout = AbortSignal.timeout(60_000);
      const res = await fetch(url, { signal: signal ? AbortSignal.any([timeout, signal]) : timeout });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  };
  const fetchClient = process.env.FETCH_SERVICE_URL && process.env.FETCH_SERVICE_SECRET
    ? createFetchClient({ baseUrl: process.env.FETCH_SERVICE_URL, secret: process.env.FETCH_SERVICE_SECRET })
    : null;
  return handleScan(req, {
    db,
    queue,
    fetchPage: (url, signal) => safeFetch(url, { signal }),
    llm: createLlmClient({ db }),
    pagespeed,
    fetchClient,
    search: createTavilySearch({ apiKey: process.env.TAVILY_API_KEY, db }),
    mentions: (domain, signal) => countHackerNewsMentions(domain, fetch, signal),
  });
}
