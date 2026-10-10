import { describe, it, expect } from "vitest";
import { runScan, type ScanEvent } from "@/lib/pipeline/run";
import { ReportSchema } from "@/lib/pipeline/schemas";
import { runTechnicalChecks } from "@/lib/checks/technical";
import { runGeoChecks } from "@/lib/checks/geo";
import type { LlmClient } from "@/lib/llm/router";
import type { FetchClient } from "@/lib/fetch-client";
import type { PageFetcher } from "@/lib/snapshot";
import { page, snap } from "./helpers/snap";

const HOME = `<html lang="en"><head><title>Acme Storage shelving</title></head><body><h1>Shelving for small homes</h1>
<a href="https://www.facebook.com/acme">fb</a><a href="https://www.instagram.com/acme">ig</a></body></html>`;
const RIVAL = `<html lang="en"><head><title>Rival shelving for homes everywhere</title></head><body><h1>Storage for every home</h1>
<a href="https://www.linkedin.com/company/rival">in</a></body></html>`;
const fetchPage: PageFetcher = async (url) => {
  const u = new URL(url);
  if (u.pathname !== "/" ) return page(url, "nope", { status: 404 });
  if (u.hostname === "example.com") return page(url, HOME);
  if (u.hostname === "rival.example") return page(url, RIVAL);
  throw new Error("ENOTFOUND");
};

const llm: LlmClient = async (o) => {
  if (o.system.includes("direct competitors")) return { content: JSON.stringify({ competitors: [{ domain: "rival.example" }, { domain: "gone.example" }] }), provider: "nim", model: "m" };
  if (o.system.includes("marketing consultant")) {
    const id = /^- (\S+) \[/m.exec(o.user)![1];
    return { content: JSON.stringify({ ideas: [{ title: "Run a quote campaign", why: "w", findingId: id, effort: "low" }] }), provider: "nim", model: "m" };
  }
  const items = ["value-prop", "audience", "cta-clarity", "differentiation"].map((id) => ({ id, passed: true, quote: "Shelving for small homes" }));
  return { content: JSON.stringify({ items }), provider: "nim", model: "m" };
};

const client = (over: Partial<FetchClient> = {}): FetchClient => ({
  healthy: async () => true,
  readProfile: async () => ({ status: "found", title: "Acme", lastActivityAt: "2026-09-20T00:00:00Z" }),
  render: async () => ({ status: "ok", words: 420, mobileOverflow: true }),
  ...over,
});

const run = (deps: Parameters<typeof runScan>[1] extends infer D ? Partial<D> : never, events: ScanEvent[] = []) =>
  runScan(new URL("https://example.com/"), { fetchPage, emit: (e) => events.push(e), llm, ...deps });

describe("runScan with the browser render, social and competitor steps", () => {
  it("runs every step in order and fills in the social summary, competitor table and rendered findings", async () => {
    const events: ScanEvent[] = [];
    const report = await run({ fetchClient: client(), mentions: async () => 5 }, events);

    expect(events.filter((e) => e.event === "step-start").map((e) => e.data.step)).toEqual([
      "fetch", "render", "technical", "geo", "content", "marketing", "performance", "social", "competitors", "synthesis",
    ]);
    expect(() => ReportSchema.parse(report)).not.toThrow();
    expect(report.modules.map((m) => m.module)).toEqual(["technical", "geo", "content", "marketing", "performance", "social"]);
    expect(report.social!.profiles.filter((p) => p.status === "found").map((p) => p.platform).sort()).toEqual(["facebook", "instagram"]);
    expect(report.social!.readerUsed).toBe(true);
    expect(report.social!.mentions).toEqual({ hackerNews: 5 });
    expect(report.competitors!.rows.map((r) => r.domain)).toEqual(["rival.example"]);
    expect(report.competitors!.gaps.length).toBeGreaterThan(0);
    expect(report.modules.find((m) => m.module === "technical")!.findings.map((f) => f.id)).toContain("technical:mobile-layout");
    expect(report.modules.find((m) => m.module === "competitors")).toBeUndefined();
  });

  it("works without the fetch service: render is skipped, profiles are not opened, competitors still compared", async () => {
    const events: ScanEvent[] = [];
    const report = await run({ fetchClient: null }, events);
    expect(events.find((e) => e.event === "step-done" && e.data.step === "render")).toBeDefined();
    expect(report.social!.readerUsed).toBe(false);
    expect(report.social!.profiles.every((p) => p.status === "linked")).toBe(true);
    expect(report.couldntCheck.map((c) => c.what).join(" ")).toMatch(/Social profile pages/);
    expect(report.competitors).not.toBeNull();
    expect(report.modules.find((m) => m.module === "technical")!.findings.map((f) => f.id)).not.toContain("technical:mobile-layout");
  });

  it("a failed browser render is skipped, not fatal", async () => {
    const report = await run({ fetchClient: client({ render: async () => ({ status: "skipped", reason: "not enough memory" }) }) });
    expect(report.modules.find((m) => m.module === "technical")).toBeDefined();
    expect(report.couldntCheck.map((c) => c.what).join(" ")).toMatch(/browser/i);
  });

  it("a competitor-step failure leaves the rest of the report intact", async () => {
    const broken: LlmClient = async (o) => {
      if (o.system.includes("direct competitors")) throw new TypeError("boom");
      return llm(o);
    };
    const report = await run({ llm: broken, fetchClient: client() });
    expect(report.competitors).toBeNull();
    expect(report.couldntCheck.map((c) => c.what).join(" ")).toMatch(/Competitor comparison/);
    expect(report.social).not.toBeNull();
  });

  it("a failing social reader leaves a social module with could-not-check entries", async () => {
    const report = await run({ fetchClient: client({ readProfile: async () => { throw new Error("down"); } }) });
    expect(report.social!.profiles.some((p) => p.status === "unreadable")).toBe(true);
  });

  it("stops once cancelled, before the next step", async () => {
    const controller = new AbortController();
    const cancelling: FetchClient = client({ render: async () => { controller.abort(); return { status: "ok", words: 1, mobileOverflow: false }; } });
    await expect(run({ fetchClient: cancelling, signal: controller.signal })).rejects.toThrow(/cancel/i);
  });
});

describe("rendered-page findings", () => {
  const SHELL = `<html lang="en"><head><title>App</title></head><body><div id="root"></div></body></html>`;
  it("flags a page that is wider than a phone screen", () => {
    const s = snap(SHELL);
    s.rendered = { words: 40, mobileOverflow: true };
    const f = runTechnicalChecks(s).find((o) => o.id === "mobile-layout")!;
    expect(f.passed).toBe(false);
    expect(f.finding!.evidence[0].note).toMatch(/phone/i);
    s.rendered = { words: 40, mobileOverflow: false };
    expect(runTechnicalChecks(s).find((o) => o.id === "mobile-layout")!.passed).toBe(true);
  });
  it("adds no mobile check when the page was not rendered", () => {
    expect(runTechnicalChecks(snap(SHELL)).some((o) => o.id === "mobile-layout")).toBe(false);
  });
  it("proves that content is missing from the HTML when a browser shows it", () => {
    const s = snap(SHELL);
    s.rendered = { words: 650, mobileOverflow: false };
    const f = runGeoChecks(s).find((o) => o.id === "content-in-html")!.finding!;
    expect(f.title).toMatch(/browser shows 650/);
    expect(f.evidence[0].note).toMatch(/650/);
  });
  it("keeps the ordinary wording when the browser sees no more than the HTML does", () => {
    const s = snap(SHELL);
    s.rendered = { words: 20, mobileOverflow: false };
    expect(runGeoChecks(s).find((o) => o.id === "content-in-html")!.finding!.title).not.toMatch(/browser/);
  });
});
