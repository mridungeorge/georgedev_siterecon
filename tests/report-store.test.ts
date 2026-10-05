import { describe, it, expect, beforeEach } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "@/lib/db";
import { saveReport, getReport, getCachedReport, purgeExpiredReports, REPORT_TTL_MS, CACHE_TTL_MS } from "@/lib/report-store";
import type { Report } from "@/lib/pipeline/schemas";

const T0 = Date.parse("2026-10-05T00:00:00.000Z");
const report = (id: string, createdAt: number, domain = "example.com"): Report => ({
  id, url: `https://${domain}/`, domain, createdAt: new Date(createdAt).toISOString(), overallScore: 70,
  modules: [], topFixes: [], fixPrompt: "p", couldntCheck: [], pagesScanned: [`https://${domain}/`], injectionFlags: 0,
});
let db: DatabaseSync;
beforeEach(() => { db = openDb(":memory:"); });

describe("report store", () => {
  it("saves and loads a report", () => {
    saveReport(db, report("abc", T0));
    expect(getReport(db, "abc", T0 + 1000)).toEqual(report("abc", T0));
    expect(getReport(db, "missing", T0)).toBeNull();
  });
  it("stops returning a report after 30 days", () => {
    saveReport(db, report("abc", T0));
    expect(getReport(db, "abc", T0 + REPORT_TTL_MS + 1)).toBeNull();
  });
  it("returns the newest report for a domain only within 24 hours", () => {
    saveReport(db, report("old", T0));
    saveReport(db, report("new", T0 + 5000));
    saveReport(db, report("other", T0 + 6000, "other.com"));
    expect(getCachedReport(db, "example.com", T0 + 10_000)?.id).toBe("new");
    expect(getCachedReport(db, "example.com", T0 + 5000 + CACHE_TTL_MS + 1)).toBeNull();
    expect(getCachedReport(db, "nobody.com", T0)).toBeNull();
  });
  it("purges expired rows", () => {
    saveReport(db, report("old", T0));
    saveReport(db, report("new", T0 + REPORT_TTL_MS));
    purgeExpiredReports(db, T0 + REPORT_TTL_MS + 1);
    const ids = (db.prepare("SELECT id FROM reports").all() as { id: string }[]).map((r) => r.id);
    expect(ids).toEqual(["new"]);
  });
  it("returns null instead of throwing on a corrupt row", () => {
    db.prepare("INSERT INTO reports (id, domain, created_at, json) VALUES (?, ?, ?, ?)").run("bad", "x.com", T0, "{not json");
    expect(getReport(db, "bad", T0)).toBeNull();
  });
});
