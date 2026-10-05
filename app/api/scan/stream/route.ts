import { handleScan } from "@/lib/scan-handler";
import { getDb } from "@/lib/db";
import { safeFetch } from "@/lib/safe-fetch";
import { ScanQueue } from "@/lib/scan-queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 400;

// One queue for the whole process: 1 active scan, 5 waiting (spec section 7).
const queue = new ScanQueue(1, 5);

export function GET(req: Request) {
  return handleScan(req, { db: getDb(), queue, fetchPage: (url, signal) => safeFetch(url, { signal }) });
}
