import type { SafeResponse } from "@/lib/safe-fetch";
import type { SiteSnapshot } from "@/lib/snapshot";
import { parseRobots } from "@/lib/robots";

export function page(url: string, body: string, extra: Partial<SafeResponse> = {}): SafeResponse {
  return {
    url, finalUrl: url, status: 200, headers: {}, contentType: "text/html; charset=utf-8",
    body, truncated: false, ...extra,
  };
}

/** A snapshot of https://example.com/ with the given homepage HTML. */
export function snap(html: string, overrides: Partial<SiteSnapshot> & { robotsTxt?: string | null } = {}): SiteSnapshot {
  const robotsTxt = overrides.robotsTxt ?? null;
  return {
    origin: "https://example.com",
    domain: "example.com",
    home: page("https://example.com/", html),
    pages: [],
    robotsTxt,
    robots: robotsTxt === null ? null : parseRobots(robotsTxt),
    sitemapUrl: null,
    sitemapXml: null,
    llmsTxt: null,
    fetchedAt: "2026-10-05T00:00:00.000Z",
    ...overrides,
  };
}
