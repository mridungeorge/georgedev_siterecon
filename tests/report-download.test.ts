import { describe, it, expect } from "vitest";
import { markdownDownload } from "@/lib/report-download";
import type { Report } from "@/lib/pipeline/schemas";

const report = (domain: string): Report => ({
  id: "abc", url: `https://${domain}/`, domain, createdAt: "2026-10-06T00:00:00.000Z", overallScore: 70,
  modules: [], topFixes: [], fixPrompt: "Fix the title.", couldntCheck: [], pagesScanned: [`https://${domain}/`], injectionFlags: 0, ideas: [], social: null, competitors: null, summary: null, fixKit: [], pageTable: [],
});

describe("markdownDownload", () => {
  it("returns the report as an attached Markdown file", () => {
    const d = markdownDownload(report("example.com"));
    expect(d.body).toContain("# SiteRecon report");
    expect(d.headers["Content-Type"]).toBe("text/markdown; charset=utf-8");
    expect(d.headers["Content-Disposition"]).toBe('attachment; filename="siterecon-example.com.md"');
  });
  it("tells the browser not to guess a different type, so the file can never be rendered as a page", () => {
    expect(markdownDownload(report("example.com")).headers["X-Content-Type-Options"]).toBe("nosniff");
  });
  it("keeps anything unusual in a domain out of the file name", () => {
    const name = markdownDownload(report('a"b\r\nSet-Cookie: x=1/../c.com')).headers["Content-Disposition"];
    expect(name).toMatch(/^attachment; filename="siterecon-[a-z0-9.-]+\.md"$/);
    expect(name).not.toMatch(/[\r\n/\\]/);
  });
  it("falls back to a plain name when nothing usable is left", () => {
    expect(markdownDownload(report("###")).headers["Content-Disposition"]).toBe('attachment; filename="siterecon-report.md"');
  });
});
