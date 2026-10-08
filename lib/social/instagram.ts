import type { ProfileRead, ProfileReader } from "@/lib/checks/social";
import type { SocialLink } from "@/lib/social/platforms";

// Reads a public Instagram business or creator account through Meta's official Graph API (Business
// Discovery), using the access token of an Instagram professional account that the site owner
// connected. It is optional: without META_IG_USER_ID and META_ACCESS_TOKEN nothing here runs, and
// Instagram links are read the old way, through the fetch service.
//
// The token is a secret. It is sent only to graph.facebook.com, as a query parameter that Meta's API
// requires, and it never appears in anything this module returns: not in a note, not in an error, not
// in a log. Error text from the network is never passed on, because it can contain the request address.

const GRAPH_VERSION = "v23.0";
/** Instagram's own rule for a username: letters, digits, dots and underscores, at most 30 characters. */
const HANDLE = /^[A-Za-z0-9._]{1,30}$/;

export interface InstagramDeps {
  /** The Instagram user id of the connected professional account (not a secret). */
  userId: string;
  /** Its access token (a secret). */
  token: string;
  /** Uses one unit of the daily budget. False means it is spent. */
  quotaOk: () => boolean;
  fetchJson: (url: string, signal?: AbortSignal) => Promise<{ status: number; body: unknown }>;
}

const unreadable = (note: string): ProfileRead => ({ status: "unreadable", note });

function compact(n: number): string {
  if (n >= 999_950) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(n);
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const oneLine = (s: string, max: number) => s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

export function createInstagramReader(deps: InstagramDeps): ProfileReader {
  return async (link: SocialLink, signal?: AbortSignal): Promise<ProfileRead> => {
    // The handle comes from the audited site's own link, and goes into the request, so it is checked first.
    const handle = link.handle;
    if (!handle || !HANDLE.test(handle)) return unreadable("the Instagram link does not name a valid account");
    if (!deps.quotaOk()) return unreadable("the daily Instagram budget has been used up");

    const fields = `business_discovery.username(${handle}){username,name,biography,followers_count,media_count,media.limit(5){timestamp}}`;
    const url =
      `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(deps.userId)}` +
      `?fields=${encodeURIComponent(fields)}&access_token=${encodeURIComponent(deps.token)}`;

    let reply: { status: number; body: unknown };
    try {
      reply = await deps.fetchJson(url, signal);
    } catch (err) {
      if (signal?.aborted) throw err;
      return unreadable("Instagram could not be reached");
    }

    const body = reply.body;
    const error = isRecord(body) && isRecord(body.error) ? body.error : null;
    if (error) {
      const code = typeof error.code === "number" ? error.code : null;
      const sub = typeof error.error_subcode === "number" ? error.error_subcode : null;
      if (code === 190) return unreadable("the Instagram access token has expired or was revoked, so it needs renewing");
      if (code !== null && [4, 17, 32, 613].includes(code)) return unreadable("Instagram's rate limit was reached, try again later");
      if (code === 110 || code === 24 || sub === 2207013 || sub === 2207001) {
        return unreadable("Instagram only shares business or creator accounts, and this one is personal, private or does not exist");
      }
    }

    const discovery = isRecord(body) && isRecord(body.business_discovery) ? body.business_discovery : null;
    if (reply.status >= 400 || !discovery) {
      return unreadable(reply.status >= 400 ? `Instagram did not give a usable answer (HTTP ${reply.status})` : "Instagram returned no business details for this account");
    }

    const followers = typeof discovery.followers_count === "number" ? discovery.followers_count : null;
    const posts = typeof discovery.media_count === "number" ? discovery.media_count : null;
    const stats = [followers !== null ? `${compact(followers)} followers` : "", posts !== null ? `${posts} posts` : ""].filter(Boolean).join(", ");

    const media = isRecord(discovery.media) && Array.isArray(discovery.media.data) ? discovery.media.data : [];
    const stamps = media
      .map((m) => (isRecord(m) && typeof m.timestamp === "string" ? Date.parse(m.timestamp) : NaN))
      .filter((t) => Number.isFinite(t));

    const name = typeof discovery.name === "string" ? oneLine(discovery.name, 120) : "";
    const username = typeof discovery.username === "string" ? oneLine(discovery.username, 40) : handle;
    const biography = typeof discovery.biography === "string" ? oneLine(discovery.biography, 300) : "";

    return {
      status: "found",
      title: name || username,
      ...(biography ? { description: biography } : {}),
      ...(stats ? { note: stats } : {}),
      ...(stamps.length > 0 ? { lastActivityAt: new Date(Math.max(...stamps)).toISOString() } : {}),
    };
  };
}

/**
 * One reader for the whole scan: the Instagram API for Instagram links, the fetch service for every
 * other platform. When Instagram's answer is not a clear yes or no, the fetch service gets a try, but
 * Instagram's explanation (for example "the token has expired") is kept unless the fetch service did better.
 */
export function composeProfileReaders(instagram: ProfileReader | null, fallback: ProfileReader | null): ProfileReader | null {
  if (!instagram) return fallback;
  return async (link, signal) => {
    if (link.platform !== "instagram") {
      return fallback ? fallback(link, signal) : unreadable("the reader for this platform is not set up on this server");
    }
    const first = await instagram(link, signal);
    if (first.status === "found" || first.status === "not_found") return first;
    let second: ProfileRead | null = null;
    if (fallback) {
      try {
        second = await fallback(link, signal);
      } catch (err) {
        if (signal?.aborted) throw err;
      }
    }
    return second && second.status === "found" ? second : first;
  };
}
