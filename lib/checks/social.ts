import type { SiteSnapshot } from "@/lib/snapshot";
import type { CheckOutcome, CouldntCheck, SocialProfile, SocialSummary } from "@/lib/pipeline/schemas";
import { classifySocialUrl, extractSocialLinks, KEY_PLATFORMS, type SocialLink } from "@/lib/social/platforms";
import { publicCountsNote } from "@/lib/social/counts";
import { makeChecker } from "./helpers";

// Public social scan. Only pages anyone can open without logging in are read, and only through
// the fetch service. A login wall is reported as "couldn't check", never worked around.

export interface ProfileRead {
  status: "found" | "not_found" | "login_wall" | "unreadable";
  title?: string;
  description?: string;
  /** ISO date of the latest public post, when the platform shows one. */
  lastActivityAt?: string;
  note?: string;
}

export type ProfileReader = (link: SocialLink, signal?: AbortSignal) => Promise<ProfileRead>;

export interface SocialResult {
  outcomes: CheckOutcome[];
  couldntCheck: CouldntCheck[];
  summary: SocialSummary;
}

const MAX_READS = 6;
const MAX_LINKS = 20;
const STALE_AFTER_MS = 180 * 24 * 60 * 60 * 1000;

export async function runSocialChecks(
  s: SiteSnapshot,
  reader: ProfileReader | null,
  signal?: AbortSignal,
  now: number = Date.now(),
): Promise<SocialResult> {
  const { outcomes, check } = makeChecker("social");
  const couldntCheck: CouldntCheck[] = [];
  const url = s.home.finalUrl;

  const extracted = extractSocialLinks(s.home.body, url);
  const sameAs = extracted.sameAs;
  // A page can link thousands of profiles. Twenty is more than any real brand needs, and it keeps the
  // report, the stored copy and the live stream small.
  const links = extracted.links.slice(0, MAX_LINKS);
  const profiles = links.filter((l) => l.kind === "profile");
  const placeholders = links.filter((l) => l.kind === "homepage");
  const platformsLinked = new Set(profiles.map((l) => l.platform));
  const list = (items: SocialLink[]) => items.map((l) => l.url).join(", ") || "none";

  check("has-profiles", 25, platformsLinked.size >= 2, {
    severity: "medium", effort: "low",
    title: platformsLinked.size === 0 ? "No social media profiles are linked from the homepage" : "Only one social media profile is linked from the homepage",
    detail: "Visitors check social profiles to see that a business is real and active, and search and AI tools use them to confirm who the business is.",
    fix: "Link your main profiles (for example Facebook, Instagram, LinkedIn) from the header or footer of every page.",
    evidence: [{ url, note: `${profiles.length} social profile link${profiles.length === 1 ? "" : "s"} found: ${list(profiles)}` }],
  });

  check("profile-links-valid", 15, placeholders.length === 0, {
    severity: "low", effort: "low",
    title: "Some social links go to a platform's front page, not to a profile",
    detail: "A link to facebook.com or instagram.com instead of the business's own page is usually an unfinished template link.",
    fix: "Replace each placeholder with the full address of the business's own profile.",
    evidence: [{ url, note: `placeholder links: ${list(placeholders)}` }],
  });

  const hasKey = KEY_PLATFORMS.some((p) => platformsLinked.has(p));
  check("key-platforms", 15, hasKey, {
    severity: "medium", effort: "medium",
    title: "No Facebook, Instagram or LinkedIn profile is linked",
    detail: "These are the profiles most customers and partners look for first.",
    fix: "Create or link at least one of Facebook, Instagram or LinkedIn, whichever your customers use most.",
    evidence: [{ url, note: `platforms linked: ${[...platformsLinked].join(", ") || "none"}` }],
  });

  const sameAsSocial = sameAs.filter((u) => classifySocialUrl(u) !== null);
  check("schema-sameas", 10, sameAsSocial.length > 0, {
    severity: "low", effort: "low",
    title: "The organisation's structured data does not list its social profiles",
    detail: "Listing profiles in the schema sameAs field helps search engines and AI tools connect the website to its social accounts.",
    fix: "Add the profile addresses to the sameAs list in the Organization JSON-LD.",
    evidence: [{ url, note: sameAs.length ? `sameAs has ${sameAs.length} entries, none of them social profiles` : "no sameAs list found" }],
  });

  const summaryProfiles: SocialProfile[] = links.map((l) => ({ platform: l.platform, url: l.url, handle: l.handle, kind: l.kind, status: "linked" as const }));

  if (reader && profiles.length > 0) {
    const toRead = profiles.slice(0, MAX_READS);
    const reads = await Promise.all(
      toRead.map(async (link): Promise<ProfileRead> => {
        try {
          return await reader(link, signal);
        } catch (err) {
          return { status: "unreadable", note: err instanceof Error ? err.message.slice(0, 120) : "read failed" };
        }
      }),
    );

    toRead.forEach((link, i) => {
      const read = reads[i];
      const entry = summaryProfiles.find((p) => p.url === link.url)!;
      entry.status = read.status;
      if (read.title) entry.title = read.title.slice(0, 120);
      if (read.note) entry.note = read.note.slice(0, 160);
      // A public page often states its audience in the description it shows to anyone. Only a found page
      // is read this way, and only when the reader did not already give a note of its own.
      else if (read.status === "found" && read.description) {
        const counts = publicCountsNote(read.description);
        if (counts) entry.note = counts;
      }
      if (read.lastActivityAt) entry.lastActivityAt = read.lastActivityAt;
      if (read.status === "login_wall") {
        couldntCheck.push({ what: `Social profile: ${link.platform}`, why: "it needs a login to read, and SiteRecon only reads public pages" });
      } else if (read.status === "unreadable") {
        couldntCheck.push({ what: `Social profile: ${link.platform}`, why: read.note ?? "the page could not be read" });
      }
    });

    // Scored only when at least one page was really answered. If every read failed (the service is
    // down, every profile is behind a login), nothing was checked, so nothing may be credited.
    const missing = toRead.filter((_, i) => reads[i].status === "not_found");
    const answered = reads.some((r) => r.status === "found" || r.status === "not_found");
    if (answered) {
      check("profiles-reachable", 25, missing.length === 0, {
        severity: "high", effort: "low",
        title: `${missing.length} linked social profile${missing.length === 1 ? " does" : "s do"} not exist`,
        detail: "A broken social link tells visitors the business is neglected, and it sends them away.",
        fix: "Correct or remove each broken social link.",
        evidence: missing.slice(0, 3).map((l) => ({ url: l.url, note: "the platform reports that this page does not exist" })),
      });
    }

    const dated = toRead
      .map((l, i) => ({ l, at: reads[i].lastActivityAt ? Date.parse(reads[i].lastActivityAt as string) : NaN }))
      .filter((x) => Number.isFinite(x.at));
    if (dated.length > 0) {
      const newest = Math.max(...dated.map((x) => x.at));
      check("profile-activity", 10, now - newest <= STALE_AFTER_MS, {
        severity: "medium", effort: "medium",
        title: "The linked social profiles look inactive",
        detail: "Profiles with no recent posts suggest a business that may have closed or stopped caring about customers.",
        fix: "Post at least monthly, or remove links to profiles you no longer use.",
        evidence: dated.slice(0, 3).map((x) => ({ url: x.l.url, note: `latest public activity ${new Date(x.at).toISOString().slice(0, 10)}` })),
      });
    }
  } else if (profiles.length > 0) {
    couldntCheck.push({ what: "Social profile pages", why: "the fetch service is not configured, so profile pages were not opened" });
  }

  return {
    outcomes,
    couldntCheck,
    summary: {
      profiles: summaryProfiles,
      missing: KEY_PLATFORMS.filter((p) => !platformsLinked.has(p)),
      mentions: null,
      readerUsed: Boolean(reader),
    },
  };
}
