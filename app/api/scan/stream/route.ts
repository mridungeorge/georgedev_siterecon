import { handleScan } from "@/lib/scan-handler";
import { getDb } from "@/lib/db";
import { safeFetch } from "@/lib/safe-fetch";
import { ScanQueue } from "@/lib/scan-queue";
import { createLlmClient } from "@/lib/llm/router";
import { tryConsumeQuota } from "@/lib/quota";
import type { PageSpeedDeps } from "@/lib/checks/performance";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 400;

// One queue for the whole process: 1 active scan, 5 waiting (spec section 7).
const queue = new ScanQueue(1, 5);

export function GET(req: Request) {
  const db = getDb();
  // Without keys these still work: the AI and PageSpeed parts are reported as "couldn't check".
  const pagespeed: PageSpeedDeps = {
    apiKey: process.env.PAGESPEED_API_KEY,
    quotaOk: () => tryConsumeQuota(db, "pagespeed"),
    fetchJson: async (url) => {
      const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  };
  return handleScan(req, {
    db,
    queue,
    fetchPage: (url, signal) => safeFetch(url, { signal }),
    llm: createLlmClient({ db }),
    pagespeed,
  });
}
