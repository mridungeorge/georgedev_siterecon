import { describe, it, expect } from "vitest";
import { runScan, type ScanEvent } from "@/lib/pipeline/run";
import { ReportSchema } from "@/lib/pipeline/schemas";
import { NotHtmlError, type PageFetcher } from "@/lib/snapshot";
import { page } from "./helpers/snap";

const O = "https://example.com";
const HOME = `<html lang="en"><head><title>Acme Storage shelving</title></head><body><h1>Shelving</h1><a href="/about">About</a></body></html>`;
const fetchPage: PageFetcher = async (url) => {
  if (url === `${O}/`) return page(url, HOME);
  if (url === `${O}/about`) return page(url, "<html>about</html>");
  return page(url, "nope", { status: 404 });
};

describe("runScan", () => {
  it("emits each step in order and returns a valid report", async () => {
    const events: ScanEvent[] = [];
    const report = await runScan(new URL(`${O}/`), { fetchPage, emit: (e) => events.push(e), newId: () => "id-1" });

    expect(events.map((e) => `${e.event}:${e.data.step}`)).toEqual([
      "step-start:fetch", "step-done:fetch",
      "step-start:render", "step-done:render", // the browser tier is not configured in this test
      "step-start:technical", "step-done:technical",
      "step-start:geo", "step-done:geo",
      "step-start:content", "step-done:content",
      "step-start:marketing", "step-done:marketing",
      "step-start:performance", "step-warn:performance", // PageSpeed is not configured in this test
      "step-start:social", "step-done:social",
      "step-start:competitors", "step-warn:competitors", // no AI and no search in this test
      "step-start:synthesis", "step-done:synthesis",
    ]);
    expect(() => ReportSchema.parse(report)).not.toThrow();
    expect(report.id).toBe("id-1");
    expect(report.domain).toBe("example.com");
    expect(report.pagesScanned).toEqual([`${O}/`, `${O}/about`]);
    expect(report.modules.map((m) => m.module)).toEqual(["technical", "geo", "content", "marketing", "performance", "social"]);
    expect(report.overallScore).toBeGreaterThan(0);
    expect(report.topFixes.length).toBeGreaterThan(0);
    expect(report.topFixes.length).toBeLessThanOrEqual(10);
    expect(report.fixPrompt).toContain(report.topFixes[0].title);
    const done = events.find((e) => e.event === "step-done" && e.data.step === "technical")!;
    expect((done.data as { message: string }).message).toMatch(/\d+ of \d+ checks passed/);
  });

  it("includes an executive summary and a fix kit built from the findings", async () => {
    const report = await runScan(new URL(`${O}/`), { fetchPage, emit: () => {}, newId: () => "id-2" });
    expect(report.summary).not.toBeNull();
    expect(report.summary!.verdict).toContain(`${report.overallScore}/100`);
    const allIds = report.modules.flatMap((m) => m.findings.map((f) => f.id));
    const planned = [...report.summary!.roadmap.thisWeek, ...report.summary!.roadmap.thisMonth, ...report.summary!.roadmap.thisQuarter];
    expect(planned.sort()).toEqual([...allIds].sort());
    // the sample site has no robots.txt, sitemap or llms.txt, so the kit offers each of them
    expect(report.fixKit.map((k) => k.id)).toEqual(expect.arrayContaining(["robots-txt", "sitemap-xml", "llms-txt", "canonical"]));
    for (const item of report.fixKit) for (const f of item.forFindings) expect(allIds).toContain(f);
  });

  it("reads an Instagram link through the Instagram reader when one is configured, and others through the fetch service", async () => {
    const home = `<html lang="en"><head><title>Acme</title></head><body><h1>Acme</h1><a href="https://www.instagram.com/acme/">Instagram</a><a href="https://www.facebook.com/acme">Facebook</a></body></html>`;
    const fetchHome: PageFetcher = async (url) => (url === `${O}/` ? page(url, home) : page(url, "nope", { status: 404 }));
    const seen: string[] = [];
    const report = await runScan(new URL(`${O}/`), {
      fetchPage: fetchHome, emit: () => {},
      instagram: async (link) => { seen.push(link.platform); return { status: "found", title: "Acme Bakery", note: "12.4K followers, 540 posts", lastActivityAt: new Date().toISOString() }; },
      fetchClient: {
        healthy: async () => true,
        render: async () => ({ status: "skipped", reason: "test" }),
        readProfile: async (link) => { seen.push(`fetch:${link.platform}`); return { status: "login_wall" }; },
      },
    });
    expect(seen.sort()).toEqual(["fetch:facebook", "instagram"]);
    const ig = report.social!.profiles.find((p) => p.platform === "instagram")!;
    expect(ig).toMatchObject({ status: "found", title: "Acme Bakery", note: "12.4K followers, 540 posts" });
    expect(report.social!.profiles.find((p) => p.platform === "facebook")!.status).toBe("login_wall");
    expect(report.social!.readerUsed).toBe(true);
  });

  it("keeps going when one module throws, and says so", async () => {
    const events: ScanEvent[] = [];
    const report = await runScan(new URL(`${O}/`), {
      fetchPage, emit: (e) => events.push(e),
      modules: { geo: () => { throw new Error("geo exploded"); } },
    });
    const geo = report.modules.find((m) => m.module === "geo")!;
    expect(geo.status).toBe("failed");
    expect(geo.score).toBeNull();
    expect(report.couldntCheck).toEqual(expect.arrayContaining([{ what: "geo", why: "geo exploded" }]));
    expect(events).toContainEqual({ event: "step-warn", data: { step: "geo", message: "geo exploded" } });
    expect(report.modules.find((m) => m.module === "technical")!.score).not.toBeNull();
  });

  it("rejects with the fetch error when the target is not a web page", async () => {
    const pdf: PageFetcher = async (url) => page(url, "%PDF", { contentType: "application/pdf" });
    const events: ScanEvent[] = [];
    await expect(runScan(new URL(`${O}/`), { fetchPage: pdf, emit: (e) => events.push(e) })).rejects.toBeInstanceOf(NotHtmlError);
    expect(events).toEqual([{ event: "step-start", data: { step: "fetch" } }]);
  });
});
