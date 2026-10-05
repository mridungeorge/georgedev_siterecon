import { describe, it, expect, beforeEach } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "@/lib/db";
import { runSocialChecks, type ProfileReader } from "@/lib/checks/social";
import { findCompetitors, registrableDomain } from "@/lib/competitors";
import { tryConsumeCompetitorFetch } from "@/lib/rate-limit";
import { runScan } from "@/lib/pipeline/run";
import type { LlmClient } from "@/lib/llm/router";
import type { PageFetcher } from "@/lib/snapshot";
import { page, snap } from "./helpers/snap";

const PAGE = `<html><body><a href="https://www.facebook.com/acme">f</a><a href="https://www.instagram.com/acme">i</a><a href="https://www.linkedin.com/company/acme">l</a></body></html>`;
const NOW = Date.parse("2026-10-05T00:00:00Z");
const reader = (status: "found" | "not_found" | "login_wall" | "unreadable"): ProfileReader => async () => ({ status });
const ids = (r: Awaited<ReturnType<typeof runSocialChecks>>) => r.outcomes.map((o) => o.id);

describe("N1: a profile that could not be read is not a profile that was checked", () => {
  it.each(["unreadable", "login_wall"] as const)("does not credit profiles-reachable when every read is %s", async (status) => {
    const r = await runSocialChecks(snap(PAGE), reader(status), undefined, NOW);
    expect(ids(r)).not.toContain("profiles-reachable");
    expect(r.couldntCheck.length).toBe(3);
    const total = r.outcomes.reduce((s, o) => s + o.weight, 0);
    expect(total).toBe(65); // only what was really measured counts
  });
  it("credits it once at least one profile was really read", async () => {
    const mixed: ProfileReader = async (l) => (l.platform === "facebook" ? { status: "found" } : { status: "unreadable" });
    const r = await runSocialChecks(snap(PAGE), mixed, undefined, NOW);
    expect(ids(r)).toContain("profiles-reachable");
  });
  it("still fails it when a profile is really missing", async () => {
    const r = await runSocialChecks(snap(PAGE), reader("not_found"), undefined, NOW);
    expect(r.outcomes.find((o) => o.id === "profiles-reachable")!.passed).toBe(false);
  });
});

describe("N2: the social list is bounded", () => {
  it("keeps at most 20 links however many the page has", async () => {
    const many = Array.from({ length: 500 }, (_, i) => `<a href="https://github.com/user${i}">u</a>`).join("");
    let reads = 0;
    const r = await runSocialChecks(snap(`<html><body>${many}</body></html>`), async () => { reads++; return { status: "found" }; }, undefined, NOW);
    expect(r.summary.profiles.length).toBeLessThanOrEqual(20);
    expect(reads).toBeLessThanOrEqual(6);
    expect(JSON.stringify(r.summary).length).toBeLessThan(20_000);
  });
});

describe("N3: competitor fetches are limited per registrable domain", () => {
  it.each([
    ["victim.com", "victim.com"], ["a.victim.com", "victim.com"], ["www.shop.victim.com", "victim.com"],
    ["shop.example.com.au", "example.com.au"], ["www.bbc.co.uk", "bbc.co.uk"], ["example.com", "example.com"], ["localhost", "localhost"],
  ])("registrableDomain(%s) is %s", (host, expected) => expect(registrableDomain(host)).toBe(expected));

  let db: DatabaseSync;
  beforeEach(() => { db = openDb(":memory:"); });
  const cfg = { perIpHour: 5, perIpDay: 10, globalDay: 50, perTargetHour: 3 };
  const HOUR = 3_600_000;

  it("allows three competitor fetches of one site per hour across all visitors, then refuses", () => {
    expect([1, 2, 3, 4].map((i) => tryConsumeCompetitorFetch(db, "a.victim.com", NOW + i, cfg))).toEqual([true, true, true, false]);
    expect(tryConsumeCompetitorFetch(db, "other.example", NOW + 5, cfg)).toBe(true);
  });
  it("counts subdomains of one site together", () => {
    for (const host of ["a.victim.com", "b.victim.com", "c.victim.com"]) expect(tryConsumeCompetitorFetch(db, host, NOW, cfg)).toBe(true);
    expect(tryConsumeCompetitorFetch(db, "d.victim.com", NOW, cfg)).toBe(false);
  });
  it("frees the allowance after an hour, and a refused attempt uses none", () => {
    for (let i = 0; i < 3; i++) tryConsumeCompetitorFetch(db, "victim.com", NOW, cfg);
    for (let i = 0; i < 5; i++) tryConsumeCompetitorFetch(db, "victim.com", NOW + 1, cfg);
    expect(tryConsumeCompetitorFetch(db, "victim.com", NOW + HOUR + 10, cfg)).toBe(true);
  });

  const HOME = `<html lang="en"><head><title>Rival shelving for homes everywhere</title></head><body><h1>Storage for every home</h1></body></html>`;
  const site: PageFetcher = async (url) => (new URL(url).pathname === "/" ? page(url, HOME) : page(url, "nope", { status: 404 }));
  const self = { domain: "acme.example", title: "Acme", description: "", summary: "s", technical: 50, geo: 50, platforms: [] };
  const ai = (domains: string[]): LlmClient => async () => ({ content: JSON.stringify({ competitors: domains.map((domain) => ({ domain })) }), provider: "nim", model: "m" });

  it("looks at only one candidate per site, so a model steered at one victim cannot fan out over its subdomains", async () => {
    const fetched = new Set<string>();
    const fetchPage: PageFetcher = async (url) => { fetched.add(new URL(url).hostname); return site(url); };
    await findCompetitors(self, { llm: ai(["a.victim.com", "b.victim.com", "c.victim.com", "d.victim.com", "e.victim.com", "f.victim.com"]), search: null, fetchPage });
    expect(fetched.size).toBe(1);
  });
  it("does not fetch a candidate whose allowance is spent", async () => {
    const fetched: string[] = [];
    const fetchPage: PageFetcher = async (url) => { fetched.push(new URL(url).hostname); return site(url); };
    const r = await findCompetitors(self, { llm: ai(["blocked.example", "fine.example"]), search: null, fetchPage, allowDomain: (d) => d !== "blocked.example" });
    expect(fetched.some((h) => h.includes("blocked.example"))).toBe(false);
    expect(r.table!.rows.map((x) => x.domain)).toEqual(["fine.example"]);
  });
  it("flows through a whole scan", async () => {
    const calls: string[] = [];
    const HOME_SELF = `<html lang="en"><head><title>Acme Storage shelving</title></head><body><h1>Shelving for small homes</h1></body></html>`;
    const fetchPage: PageFetcher = async (url) => {
      const u = new URL(url);
      calls.push(u.hostname);
      return u.hostname === "example.com" ? (u.pathname === "/" ? page(url, HOME_SELF) : page(url, "nope", { status: 404 })) : site(url);
    };
    const llm: LlmClient = async (o) => o.system.includes("direct competitors")
      ? { content: '{"competitors":[{"domain":"only-this.example"}]}', provider: "nim", model: "m" }
      : { content: '{"items":[],"ideas":[]}', provider: "nim", model: "m" };
    const report = await runScan(new URL("https://example.com/"), { fetchPage, emit: () => {}, llm, allowCompetitorDomain: () => false });
    expect(calls.some((h) => h.includes("only-this.example"))).toBe(false);
    expect(report.competitors).toBeNull();
  });
});
