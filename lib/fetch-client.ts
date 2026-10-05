import { z } from "zod";
import type { SocialLink } from "@/lib/social/platforms";
import type { ProfileRead } from "@/lib/checks/social";

// Client for siterecon-fetch, the small Python service on the same machine that reads public
// social pages and renders the homepage in a browser. It is optional: every call here turns a
// failure into a "skipped" or "unreadable" answer, so the audit still completes without it.

const ProfileReadSchema = z.object({
  status: z.enum(["found", "not_found", "login_wall", "unreadable"]),
  title: z.string().optional(),
  description: z.string().optional(),
  lastActivityAt: z.string().optional(),
  note: z.string().optional(),
});

const RenderSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), words: z.number().int().min(0), mobileOverflow: z.boolean(), screenshot: z.string().optional() }),
  z.object({ status: z.literal("skipped"), reason: z.string() }),
]);
export type RenderResult = z.infer<typeof RenderSchema>;

export interface FetchClient {
  healthy(signal?: AbortSignal): Promise<boolean>;
  readProfile(link: SocialLink, signal?: AbortSignal): Promise<ProfileRead>;
  render(url: string, signal?: AbortSignal): Promise<RenderResult>;
}

export interface FetchClientOptions {
  baseUrl: string;
  secret: string;
  fetch?: typeof fetch;
}

export function createFetchClient(opts: FetchClientOptions): FetchClient {
  const doFetch = opts.fetch ?? fetch;
  const base = opts.baseUrl.replace(/\/+$/, "");

  const call = async (path: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<unknown> => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const res = await doFetch(`${base}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", "X-SiteRecon-Secret": opts.secret },
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    });
    if (!res.ok) throw new Error(`fetch service returned HTTP ${res.status}`);
    return res.json();
  };

  return {
    async healthy(signal) {
      try {
        const body = (await call("/health", { method: "GET" }, 5_000, signal)) as { ok?: unknown };
        return body?.ok === true;
      } catch {
        return false;
      }
    },
    async readProfile(link, signal) {
      try {
        const body = await call("/social/read", { method: "POST", body: JSON.stringify({ url: link.url, platform: link.platform }) }, 30_000, signal);
        const parsed = ProfileReadSchema.safeParse(body);
        return parsed.success ? parsed.data : { status: "unreadable", note: "the fetch service gave an unexpected answer" };
      } catch (err) {
        if (signal?.aborted) throw err;
        return { status: "unreadable", note: err instanceof Error ? err.message.slice(0, 120) : "read failed" };
      }
    },
    async render(url, signal) {
      try {
        const body = await call("/render", { method: "POST", body: JSON.stringify({ url }) }, 70_000, signal);
        const parsed = RenderSchema.safeParse(body);
        return parsed.success ? parsed.data : { status: "skipped", reason: "the fetch service gave an unexpected answer" };
      } catch (err) {
        if (signal?.aborted) throw err;
        return { status: "skipped", reason: err instanceof Error ? err.message.slice(0, 120) : "render failed" };
      }
    },
  };
}
