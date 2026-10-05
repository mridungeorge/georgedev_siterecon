import * as cheerio from "cheerio";
import type { Platform } from "@/lib/pipeline/schemas";

export interface SocialLink {
  platform: Platform;
  /** Canonical profile URL (or the platform homepage for a placeholder link). */
  url: string;
  handle: string | null;
  /** "homepage" means the site links to the platform itself, not to a profile on it. */
  kind: "profile" | "homepage";
}

/** The platforms a typical small business is expected to be on. */
export const KEY_PLATFORMS: Platform[] = ["facebook", "instagram", "linkedin"];

const HOSTS: [domain: string, platform: Platform, canonical: string][] = [
  ["facebook.com", "facebook", "www.facebook.com"],
  ["fb.com", "facebook", "www.facebook.com"],
  ["fb.me", "facebook", "www.facebook.com"],
  ["instagram.com", "instagram", "www.instagram.com"],
  ["x.com", "x", "x.com"],
  ["twitter.com", "x", "x.com"],
  ["linkedin.com", "linkedin", "www.linkedin.com"],
  ["youtube.com", "youtube", "www.youtube.com"],
  ["tiktok.com", "tiktok", "www.tiktok.com"],
  ["pinterest.com", "pinterest", "www.pinterest.com"],
  ["pinterest.com.au", "pinterest", "www.pinterest.com"],
  ["github.com", "github", "github.com"],
];

/** Paths that are never a profile: sharing buttons, posts, login pages and so on. */
const RESERVED = new Set([
  "explore", "home", "search", "i", "hashtag", "intent", "share", "sharer", "settings", "about", "login", "signup",
  "policies", "help", "privacy", "terms", "tr", "dialog", "plugins", "watch", "embed", "pin", "p", "reel", "reels",
  "stories", "tv", "oauth", "legal", "business", "ads", "directory", "public", "feed", "results", "playlist", "shorts",
]);

function lookup(host: string): { platform: Platform; canonical: string } | null {
  const h = host.toLowerCase();
  for (const [domain, platform, canonical] of HOSTS) {
    if (h === domain || h.endsWith(`.${domain}`)) return { platform, canonical };
  }
  return null;
}

export function platformOfHost(host: string): Platform | null {
  return lookup(host)?.platform ?? null;
}

/** Turns a link into a social profile reference, or null if it is not a profile (a share button, a post, and so on). */
export function classifySocialUrl(href: string, base?: string): SocialLink | null {
  let u: URL;
  try {
    u = new URL(href, base);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const hit = lookup(u.hostname);
  if (!hit) return null;
  if (u.hostname.toLowerCase() === "youtu.be") return null;

  const segs = u.pathname.split("/").filter(Boolean);
  if (segs.length === 0) return { platform: hit.platform, url: `https://${hit.canonical}/`, handle: null, kind: "homepage" };

  const first = segs[0];
  if (RESERVED.has(first.toLowerCase())) return null;

  let handle: string | null = null;
  switch (hit.platform) {
    case "linkedin":
      if (["company", "in", "school"].includes(first) && segs[1]) handle = `${first}/${segs[1]}`;
      break;
    case "youtube":
      if (first.startsWith("@")) handle = first;
      else if (["channel", "c", "user"].includes(first) && segs[1]) handle = `${first}/${segs[1]}`;
      break;
    case "facebook":
      if (first === "profile.php") {
        const id = u.searchParams.get("id");
        if (id) handle = `profile.php?id=${id}`;
      } else if (["pages", "people", "groups"].includes(first) && segs[1]) handle = `${first}/${segs[1]}`;
      else handle = first;
      break;
    case "tiktok":
      if (first.startsWith("@")) handle = first;
      break;
    default:
      handle = first;
  }
  if (!handle) return null;
  return { platform: hit.platform, url: `https://${hit.canonical}/${handle}`, handle, kind: "profile" };
}

function collectSameAs(node: unknown, out: string[], depth = 0): void {
  if (depth > 8 || node === null || typeof node !== "object") return;
  if (Array.isArray(node)) return node.forEach((item) => collectSameAs(item, out, depth + 1));
  const record = node as Record<string, unknown>;
  const sameAs = record.sameAs;
  for (const value of Array.isArray(sameAs) ? sameAs : [sameAs]) if (typeof value === "string") out.push(value);
  for (const value of Object.values(record)) collectSameAs(value, out, depth + 1);
}

/** Every social profile linked from a page, once each, plus the sameAs list from its structured data. */
export function extractSocialLinks(html: string, base: string): { links: SocialLink[]; sameAs: string[] } {
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const links: SocialLink[] = [];
  $("a[href]").each((_, el) => {
    const link = classifySocialUrl($(el).attr("href") ?? "", base);
    if (!link) return;
    const key = `${link.platform}:${link.handle?.toLowerCase() ?? "home"}`;
    if (seen.has(key)) return;
    seen.add(key);
    links.push(link);
  });

  const sameAs: string[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      collectSameAs(JSON.parse($(el).text()), sameAs);
    } catch {
      // invalid JSON-LD is ignored
    }
  });
  return { links, sameAs };
}
