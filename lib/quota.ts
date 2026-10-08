import type { DatabaseSync } from "node:sqlite";

// Daily guards for the free-tier providers. They sit below each provider's real free limit,
// so exhausting one degrades a module to "couldn't check" instead of ever reaching a paid tier.

const DAY = 24 * 60 * 60 * 1000;

export type QuotaName = "llm" | "pagespeed" | "search" | "instagram";
export type QuotaLimits = Record<QuotaName, number>;

function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function quotaLimits(env: Record<string, string | undefined> = process.env): QuotaLimits {
  return {
    llm: num(env.QUOTA_LLM_DAY, 400), // each scan uses about 3 to 4 units: content review, competitors and ideas
    pagespeed: num(env.QUOTA_PAGESPEED_DAY, 200),
    search: num(env.QUOTA_SEARCH_DAY, 30), // Tavily's free plan is 1,000 credits a month
    instagram: num(env.QUOTA_INSTAGRAM_DAY, 150), // Meta allows about 200 Business Discovery calls an hour per account
  };
}

/** Uses one unit of a provider's daily budget. Returns false, using nothing, when it is spent. */
export function tryConsumeQuota(
  db: DatabaseSync,
  name: QuotaName,
  now: number = Date.now(),
  limits: QuotaLimits = quotaLimits(),
): boolean {
  const bucket = `quota:${name}`;
  const row = db.prepare("SELECT COUNT(*) AS c FROM hits WHERE bucket = ? AND ts > ?").get(bucket, now - DAY) as { c: number };
  if (row.c >= limits[name]) return false;
  db.prepare("INSERT INTO hits (bucket, ts) VALUES (?, ?)").run(bucket, now);
  return true;
}
