import { Agent, fetch as undiciFetch } from "undici";
import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupFunction } from "node:net";
import { isBlockedAddress, normalizeTargetUrl } from "./url-guard";

export const USER_AGENT = "SiteReconBot/0.1 (+https://siterecon.georgemridun.dev/methodology)";

export class BlockedAddressError extends Error {}

export interface SafeResponse {
  url: string;
  finalUrl: string;
  status: number;
  headers: Record<string, string>;
  contentType: string;
  body: string;
  truncated: boolean;
}

type Resolved = { address: string; family: number };

export interface SafeFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  signal?: AbortSignal;
  /** Test seams. Production callers leave these unset. */
  validateUrl?: (u: string) => URL;
  resolve?: (hostname: string) => Promise<Resolved[]>;
  isBlocked?: (ip: string) => boolean;
}

const defaultResolve = (hostname: string): Promise<Resolved[]> => dnsLookup(hostname, { all: true });

/**
 * The address check happens inside the socket's own DNS lookup, so the address we
 * validated is the address we connect to. Checking first and connecting later would
 * leave a gap for DNS rebinding.
 */
function guardedAgent(resolve: (h: string) => Promise<Resolved[]>, isBlocked: (ip: string) => boolean): Agent {
  const lookup: LookupFunction = (hostname, options, callback) => {
    const cb = callback as (err: Error | null, address?: unknown, family?: number) => void;
    resolve(hostname).then(
      (list) => {
        if (list.length === 0) return cb(new Error(`${hostname} did not resolve`));
        if (list.some((a) => isBlocked(a.address))) {
          return cb(new BlockedAddressError(`${hostname} resolves to a private or reserved address`));
        }
        if ((options as { all?: boolean }).all) return cb(null, list);
        cb(null, list[0].address, list[0].family);
      },
      (err: Error) => cb(err),
    );
  };
  return new Agent({ connect: { lookup } });
}

async function readCapped(body: AsyncIterable<Uint8Array> | null, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  if (!body) return { text: "", truncated: false };
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for await (const chunk of body) {
    const room = maxBytes - total;
    if (chunk.byteLength > room) {
      chunks.push(chunk.subarray(0, room));
      total = maxBytes;
      truncated = true;
      break; // leaving the loop cancels the stream
    }
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  // fatal:false, so bytes that are not valid UTF-8 become replacement characters.
  const text = new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(chunks));
  return { text, truncated };
}

/** Every request SiteRecon makes to an audited site goes through here. */
export async function safeFetch(target: string, opts: SafeFetchOptions = {}): Promise<SafeResponse> {
  const {
    timeoutMs = 15_000,
    maxBytes = 2_000_000,
    maxRedirects = 5,
    validateUrl = normalizeTargetUrl,
    resolve = defaultResolve,
    isBlocked = isBlockedAddress,
  } = opts;

  const dispatcher = guardedAgent(resolve, isBlocked);
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;

  try {
    const first = validateUrl(target);
    let current = first;
    for (let hop = 0; hop <= maxRedirects; hop++) {
      let res;
      try {
        res = await undiciFetch(current, {
          dispatcher,
          redirect: "manual",
          signal,
          headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml,text/plain,application/xml;q=0.9,*/*;q=0.5" },
        });
      } catch (err) {
        const cause = (err as { cause?: unknown }).cause;
        if (cause instanceof BlockedAddressError) throw cause;
        throw err;
      }

      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel();
        current = validateUrl(new URL(location, current).toString()); // every hop is re-validated
        continue;
      }

      const { text, truncated } = await readCapped(res.body as AsyncIterable<Uint8Array> | null, maxBytes);
      const headers: Record<string, string> = {};
      res.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });
      return {
        url: first.toString(),
        finalUrl: current.toString(),
        status: res.status,
        headers,
        contentType: headers["content-type"] ?? "",
        body: text,
        truncated,
      };
    }
    throw new Error(`too many redirects (more than ${maxRedirects})`);
  } finally {
    await dispatcher.destroy().catch(() => {});
  }
}
