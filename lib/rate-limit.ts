import type { DatabaseSync } from "node:sqlite";

// Same shape as RepoRecon's lib/rate-limit.ts (per-IP window plus a global daily cap),
// with two differences: counters are stored in SQLite so a deploy restart does not
// reset them, and there is a per-target limit because SiteRecon sends traffic to
// other people's websites.

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export interface RateLimitConfig {
  perIpHour: number;
  perIpDay: number;
  globalDay: number;
  perTargetHour: number;
}

export type RateLimitReason = "per-ip" | "per-ip-daily" | "global" | "per-target";

export interface RateLimitResult {
  allowed: boolean;
  reason?: RateLimitReason;
  retryAfterMs?: number;
}

function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function configFromEnv(env: Record<string, string | undefined> = process.env): RateLimitConfig {
  return {
    perIpHour: num(env.RL_PER_IP_HOUR, 5),
    perIpDay: num(env.RL_PER_IP_DAY, 10),
    globalDay: num(env.RL_GLOBAL_DAY, 50),
    perTargetHour: num(env.RL_PER_TARGET_HOUR, 3),
  };
}

function buckets(ip: string, domain: string): string[] {
  return ["global", `ip:${ip}`, `target:${domain}`];
}

/** Reads the limits without recording anything, so a rejected or invalid request costs nothing. */
export function peekRateLimit(
  db: DatabaseSync,
  ip: string,
  domain: string,
  now: number = Date.now(),
  cfg: RateLimitConfig = configFromEnv(),
): RateLimitResult {
  const count = db.prepare("SELECT COUNT(*) AS c, MIN(ts) AS oldest FROM hits WHERE bucket = ? AND ts > ?");
  const rules: [bucket: string, windowMs: number, limit: number, reason: RateLimitReason][] = [
    ["global", DAY, cfg.globalDay, "global"],
    [`ip:${ip}`, HOUR, cfg.perIpHour, "per-ip"],
    [`ip:${ip}`, DAY, cfg.perIpDay, "per-ip-daily"],
    [`target:${domain}`, HOUR, cfg.perTargetHour, "per-target"],
  ];
  for (const [bucket, windowMs, limit, reason] of rules) {
    const row = count.get(bucket, now - windowMs) as { c: number; oldest: number | null };
    if (row.c >= limit) {
      return { allowed: false, reason, retryAfterMs: windowMs - (now - (row.oldest ?? now)) };
    }
  }
  return { allowed: true };
}

/** Records one scan. Returns a token that refundRateLimit accepts. */
export function commitRateLimit(db: DatabaseSync, ip: string, domain: string, now: number = Date.now()): number {
  db.prepare("DELETE FROM hits WHERE ts <= ?").run(now - DAY);
  const insert = db.prepare("INSERT INTO hits (bucket, ts) VALUES (?, ?)");
  for (const bucket of buckets(ip, domain)) insert.run(bucket, now);
  return now;
}

/** Gives a scan back, for when the target turned out to be unreachable or not a web page. */
export function refundRateLimit(db: DatabaseSync, ip: string, domain: string, token: number): void {
  const remove = db.prepare(
    "DELETE FROM hits WHERE rowid IN (SELECT rowid FROM hits WHERE bucket = ? AND ts = ? LIMIT 1)",
  );
  for (const bucket of buckets(ip, domain)) remove.run(bucket, token);
}

// SECURITY NOTE (same as RepoRecon): x-forwarded-for is attacker-controlled unless the
// proxy in front of this process sets its own copy. Only set TRUST_PROXY=true once the
// edge (Caddy on the VM) is confirmed to do that. Unset, every visitor shares one bucket:
// safe, but the per-IP limits then act as global ones.
export function getClientIp(req: Request): string {
  if (process.env.TRUST_PROXY !== "true") return "untrusted-client";
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}
