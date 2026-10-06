import { describe, it, expect } from "vitest";
import { reportToMarkdown } from "@/lib/report-markdown";
import type { Report } from "@/lib/pipeline/schemas";

const finding = (id: string, title: string, quote?: string) => ({
  id, module: "technical" as const, severity: "high" as const, effort: "low" as const, title, detail: "Why it matters.", fix: "Do the fix.",
  evidence: [{ url: "https://acme.example/", note: "what was seen", ...(quote ? { quote } : {}) }],
});

const REPORT: Report = {
  id: "r1", url: "https://acme.example/", domain: "acme.example", createdAt: "2026-10-05T01:02:03.000Z", overallScore: 71,
  modules: [
    { module: "technical", status: "ok", score: 80, findings: [finding("technical:title", "The homepage has no title tag")], passed: [], couldntCheck: [] },
    { module: "performance", status: "failed", score: null, findings: [], passed: [], couldntCheck: [] },
  ],
  topFixes: [finding("technical:title", "The homepage has no title tag", "Welcome")],
  fixPrompt: "I ran an audit.\n\n1. Fix the title.",
  couldntCheck: [{ what: "performance", why: "no PageSpeed API key is configured" }],
  pagesScanned: ["https://acme.example/"], injectionFlags: 0,
  ideas: [{ title: "Add a title tag", why: "Search results need one.", findingId: "technical:title", effort: "low" }],
  social: { profiles: [{ platform: "github", url: "https://github.com/acme", handle: "acme", kind: "profile", status: "found" }], missing: ["facebook", "instagram", "linkedin"], mentions: { hackerNews: 3 }, readerUsed: true },
  competitors: { rows: [{ domain: "rival.example", url: "https://rival.example/", source: "ai", technical: 90, geo: 60, platforms: ["facebook"] }], gaps: ["1 of 1 competitors score at least 10 points higher on SEO."], note: "Suggested by AI." },
};

describe("reportToMarkdown", () => {
  const md = reportToMarkdown(REPORT);

  it("has the headline numbers and every section that has content", () => {
    expect(md).toMatch(/^# SiteRecon report: acme\.example/);
    expect(md).toContain("Overall score: 71");
    for (const heading of ["## Scores", "## Top fixes", "## Marketing ideas", "## Competitor comparison", "## Social media", "## Could not check", "## Fix with Claude"]) {
      expect(md, heading).toContain(heading);
    }
    expect(md).toContain("The homepage has no title tag");
    expect(md).toContain("rival.example");
    expect(md).toContain("no PageSpeed API key is configured");
    expect(md).toContain("n/a"); // a module with no score says so
  });

  it("puts the Claude prompt in a code block, whole", () => {
    expect(md).toMatch(/```[\s\S]*I ran an audit\.\n\n1\. Fix the title\.[\s\S]*```/);
  });

  it("leaves out sections that have nothing in them", () => {
    const bare = reportToMarkdown({ ...REPORT, ideas: [], competitors: null, social: null, topFixes: [], couldntCheck: [] });
    for (const heading of ["## Marketing ideas", "## Competitor comparison", "## Social media", "## Could not check"]) expect(bare).not.toContain(heading);
    expect(bare).toContain("No issues found");
  });

  it("neutralises text taken from the audited site, so a hostile page cannot inject HTML or links", () => {
    const hostile = "[click me](javascript:alert(1)) <script>alert(2)</script> <img src=x onerror=alert(3)> `|` | pipe";
    const out = reportToMarkdown({
      ...REPORT,
      topFixes: [finding("technical:title", hostile, hostile)],
      ideas: [{ title: hostile, why: hostile, findingId: "technical:title", effort: "low" }],
      couldntCheck: [{ what: hostile, why: hostile }],
      social: { ...REPORT.social!, profiles: [{ ...REPORT.social!.profiles[0], title: hostile, note: hostile }] },
    });
    expect(out).not.toMatch(/<script/i);
    expect(out).not.toMatch(/<img/i);
    expect(out).not.toMatch(/\]\(javascript:/i);
    expect(out).not.toMatch(/[^\\]<[a-z]/i); // no unescaped tag opener anywhere
  });

  it("keeps a table row on one line even when a cell contains a pipe or a newline", () => {
    const out = reportToMarkdown({ ...REPORT, competitors: { ...REPORT.competitors!, rows: [{ ...REPORT.competitors!.rows[0], domain: "a|b\nc.example" }] } });
    const row = out.split("\n").find((l) => l.includes("c.example"))!;
    expect(row.startsWith("|")).toBe(true);
    expect(row.match(/(?<!\\)\|/g)!.length).toBe(5); // 4 columns, 5 unescaped separators
  });

  it("is the same every time", () => {
    expect(reportToMarkdown(REPORT)).toBe(reportToMarkdown(REPORT));
  });
});

describe("the Claude prompt block", () => {
  it("cannot be closed early by backticks inside the prompt", () => {
    const evil = "ok\n```\n# injected heading\n[x](javascript:alert(1))\n````\nmore";
    const out = reportToMarkdown({ ...REPORT, fixPrompt: evil });
    const open = out.split("\n").find((l) => /^`{3,}$/.test(l))!;
    expect(open.length).toBeGreaterThan(4); // longer than the longest run inside (4)
    const closers = out.split("\n").filter((l) => l === open);
    expect(closers).toHaveLength(2); // exactly one opening and one closing fence
    expect(out.indexOf(evil)).toBeGreaterThan(out.indexOf(open));
  });
});
