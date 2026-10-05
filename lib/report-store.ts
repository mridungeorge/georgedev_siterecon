import type { DatabaseSync } from "node:sqlite";
import { ReportSchema, type Report } from "@/lib/pipeline/schemas";

export const REPORT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function parse(json: string | undefined): Report | null {
  if (!json) return null;
  try {
    return ReportSchema.parse(JSON.parse(json));
  } catch {
    return null; // a corrupt or outdated row is treated as missing
  }
}

export function saveReport(db: DatabaseSync, report: Report): void {
  db.prepare("INSERT OR REPLACE INTO reports (id, domain, created_at, json) VALUES (?, ?, ?, ?)")
    .run(report.id, report.domain, Date.parse(report.createdAt), JSON.stringify(report));
}

export function getReport(db: DatabaseSync, id: string, now: number = Date.now()): Report | null {
  const row = db.prepare("SELECT json FROM reports WHERE id = ? AND created_at > ?").get(id, now - REPORT_TTL_MS) as
    | { json: string }
    | undefined;
  return parse(row?.json);
}

/** The newest report for a domain from the last 24 hours, so repeat scans cost no quota. */
export function getCachedReport(db: DatabaseSync, domain: string, now: number = Date.now()): Report | null {
  const row = db
    .prepare("SELECT json FROM reports WHERE domain = ? AND created_at > ? ORDER BY created_at DESC LIMIT 1")
    .get(domain, now - CACHE_TTL_MS) as { json: string } | undefined;
  return parse(row?.json);
}

export function purgeExpiredReports(db: DatabaseSync, now: number = Date.now()): void {
  db.prepare("DELETE FROM reports WHERE created_at <= ?").run(now - REPORT_TTL_MS);
}
