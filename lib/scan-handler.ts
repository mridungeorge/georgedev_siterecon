import type { DatabaseSync } from "node:sqlite";
import { corsHeaders } from "./cors";
import { InvalidTargetError, normalizeTargetUrl, targetDomain } from "./url-guard";
import { commitRateLimit, getClientIp, peekRateLimit, refundRateLimit } from "./rate-limit";
import { getCachedReport, purgeExpiredReports, saveReport } from "./report-store";
import { BlockedByRobotsError, NotHtmlError, TargetUnreachableError, type PageFetcher } from "./snapshot";
import { BlockedAddressError } from "./safe-fetch";
import { runScan } from "./pipeline/run";
import type { ScanQueue } from "./scan-queue";

export interface ScanDeps {
  db: DatabaseSync;
  fetchPage: PageFetcher;
  queue: ScanQueue;
  now?: () => number;
  scanTimeoutMs?: number;
  heartbeatMs?: number;
}

const SCAN_TIMEOUT_MS = 6 * 60 * 1000;
const HEARTBEAT_MS = 15_000;

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** A failure that was the target's doing, not the visitor's, so the scan is given back. */
function isRefundable(err: unknown): boolean {
  return err instanceof TargetUnreachableError || err instanceof NotHtmlError ||
    err instanceof BlockedByRobotsError || err instanceof BlockedAddressError || err instanceof InvalidTargetError;
}

/**
 * Order matters and differs from RepoRecon on purpose: validate, then peek at the
 * limits, then the cache, then the queue, and only then record the scan. A typo, a
 * cache hit or a busy server never costs the visitor one of their scans.
 */
export async function handleScan(req: Request, deps: ScanDeps): Promise<Response> {
  const cors = corsHeaders(req.headers.get("origin"));
  const now = deps.now ?? Date.now;
  const json = (status: number, body: Record<string, unknown>, extra: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...cors, ...extra } });
  const stream = (body: ReadableStream<Uint8Array>) =>
    new Response(body, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", ...cors } });

  let target: URL;
  try {
    target = normalizeTargetUrl(new URL(req.url).searchParams.get("url") ?? "");
  } catch (err) {
    return json(400, { error: err instanceof InvalidTargetError ? err.message : "That does not look like a valid website address." });
  }
  const domain = targetDomain(target);
  const ip = getClientIp(req);
  const encoder = new TextEncoder();

  const limit = peekRateLimit(deps.db, ip, domain, now());
  if (!limit.allowed) {
    const seconds = Math.ceil((limit.retryAfterMs ?? 0) / 1000);
    return json(
      429,
      { error: `Rate limit reached (${limit.reason}). Try again in about ${Math.ceil(seconds / 60)} minutes.`, reason: limit.reason, retryAfterMs: limit.retryAfterMs },
      { "Retry-After": String(seconds) },
    );
  }

  const cached = getCachedReport(deps.db, domain, now());
  if (cached) {
    return stream(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(sse("cached", { createdAt: cached.createdAt })));
        controller.enqueue(encoder.encode(sse("report", cached)));
        controller.close();
      },
    }));
  }

  const slot = deps.queue.tryEnter();
  if (!slot) return json(503, { error: "SiteRecon is busy right now. Please try again in a few minutes." }, { "Retry-After": "120" });

  const token = commitRateLimit(deps.db, ip, domain, now());

  let open = true;
  let disconnect: (err: Error) => void = () => {};
  const disconnected = new Promise<never>((_, reject) => { disconnect = reject; });
  disconnected.catch(() => {}); // handled through the race below

  return stream(new ReadableStream({
    // Runs when the visitor closes the connection. The scan stops waiting and the queue
    // slot is freed. Requests already in flight end on their own 15-second timeouts.
    cancel() {
      open = false;
      disconnect(new Error("The visitor disconnected."));
    },
    async start(controller) {
      const send = (chunk: string) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          open = false; // the visitor closed the connection
        }
      };
      const heartbeat = setInterval(() => send(": ping\n\n"), deps.heartbeatMs ?? HEARTBEAT_MS);
      let timer: ReturnType<typeof setTimeout> | undefined;
      let release: (() => void) | undefined;

      try {
        release = await slot;
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("The scan took too long and was stopped.")), deps.scanTimeoutMs ?? SCAN_TIMEOUT_MS);
        });
        const report = await Promise.race([
          runScan(target, { fetchPage: deps.fetchPage, emit: (e) => send(sse(e.event, e.data)) }),
          timeout,
          disconnected,
        ]);
        saveReport(deps.db, report);
        purgeExpiredReports(deps.db, now());
        send(sse("report", report));
      } catch (err) {
        if (isRefundable(err)) refundRateLimit(deps.db, ip, domain, token);
        send(sse("error", { message: err instanceof Error ? err.message : "The scan failed." }));
      } finally {
        clearInterval(heartbeat);
        clearTimeout(timer);
        release?.();
        if (open) controller.close();
      }
    },
  }));
}
