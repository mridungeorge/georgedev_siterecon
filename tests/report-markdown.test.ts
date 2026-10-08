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
  summary: {
    grade: "C", verdict: "Decent (C, 71/100). Strongest: SEO (80), weakest: Speed (40). 1 issue found, 1 of them a quick win.",
    strongest: { module: "technical", score: 80 }, weakest: { module: "performance", score: 40 },
    counts: { critical: 0, high: 1, medium: 0, low: 0 }, quickWins: ["technical:title"],
    roadmap: { thisWeek: ["technical:title"], thisMonth: [], thisQuarter: [] },
  },
  fixKit: [{
    id: "canonical", title: "Canonical tag", filename: "the <head> of the homepage", language: "html",
    content: '<link rel="canonical" href="https://acme.example/">', note: "Tells search engines which address is the main one.", forFindings: ["technical:title"],
  }],
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
      fixKit: [], // a fix kit holds code meant to be pasted as it is; it has its own tests
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
    const out = reportToMarkdown({ ...REPORT, fixKit: [], fixPrompt: evil });
    const open = out.split("\n").find((l) => /^`{3,}$/.test(l))!;
    expect(open.length).toBeGreaterThan(4); // longer than the longest run inside (4)
    const closers = out.split("\n").filter((l) => l === open);
    expect(closers).toHaveLength(2); // exactly one opening and one closing fence
    expect(out.indexOf(evil)).toBeGreaterThan(out.indexOf(open));
  });
});

describe("reportToMarkdown summary, roadmap and fix kit", () => {
  const md = reportToMarkdown(REPORT);
  it("opens with the summary", () => {
    expect(md).toContain("## Summary");
    expect(md).toContain("Decent");
    expect(md).toContain("71/100");
    expect(md.indexOf("## Summary")).toBeLessThan(md.indexOf("## Scores"));
  });
  it("lays out the roadmap by effort, naming each finding", () => {
    expect(md).toContain("## Roadmap");
    expect(md).toMatch(/### This week\n\n- high: The homepage has no title tag/);
    expect(md).not.toContain("### This month");
  });
  it("puts each ready-to-paste fix in a code block with where it goes and what to check", () => {
    expect(md).toContain("## Ready-to-paste fixes");
    expect(md).toContain("### Canonical tag");
    expect(md).toContain("Where it goes:");
    expect(md).toMatch(/```html\n<link rel="canonical" href="https:\/\/acme.example\/">\n```/);
    expect(md).toContain("Tells search engines which address is the main one.");
  });
  it("cannot be broken out of by fix-kit content that contains a code fence", () => {
    const hostile = { ...REPORT, fixKit: [{ ...REPORT.fixKit[0], content: "```\n# injected heading\n[x](javascript:alert(1))\n```" }] };
    const out = reportToMarkdown(hostile);
    const open = out.split("\n").find((l) => /^`{4,}html$/.test(l));
    expect(open).toBeDefined();
    expect(out).toContain(`\n${open!.slice(0, -4)}\n`);
  });
  it("leaves the sections out when the report has none", () => {
    const bare = reportToMarkdown({ ...REPORT, summary: null, fixKit: [] });
    expect(bare).not.toContain("## Summary");
    expect(bare).not.toContain("## Roadmap");
    expect(bare).not.toContain("## Ready-to-paste fixes");
  });
});
