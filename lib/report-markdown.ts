import type { Finding, Report } from "@/lib/pipeline/schemas";

// Turns a report into a Markdown document the visitor can keep. Much of a report is text taken from
// the audited site or written by a model, so none of it is allowed to become markup: ordinary text is
// escaped, and anything that is a URL or a quotation goes in a code span, where nothing is interpreted.

const MODULE_LABEL: Record<string, string> = {
  technical: "SEO", geo: "AI visibility", content: "Content and conversion", performance: "Speed", social: "Social media", competitors: "Competitors",
};

/** Plain text, safe to put in a Markdown line or a table cell. */
function esc(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[\\`*_{}[\]()#+!|~]/g, "\\$&");
}

/** Inline code: URLs and quotations. Backticks and line breaks are removed so it cannot end early. */
function code(text: string): string {
  // Angle brackets become look-alike characters: a correct renderer would leave them alone inside a
  // code span, but a downloaded file is opened in many viewers and not every one is correct.
  const clean = text.replace(/[`\r\n]+/g, " ").replace(/</g, "‹").replace(/>/g, "›").replace(/\]\(/g, "]​(").replace(/\s+/g, " ").trim();
  return clean ? `\`${clean}\`` : "";
}

/** A fence one backtick longer than any run of backticks inside the text. */
function fence(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  return "`".repeat(Math.max(3, longest + 1));
}

const score = (n: number | null) => (n === null ? "n/a" : String(n));

function findingBlock(f: Finding, n: number): string {
  const evidence = f.evidence
    .map((e) => `- Evidence: ${[esc(e.note ?? ""), e.quote ? code(e.quote) : "", `(${code(e.url)})`].filter(Boolean).join(" ")}`)
    .join("\n");
  return `### ${n}. ${esc(f.title)}\n\n${esc(f.severity)} severity, ${esc(f.effort)} effort\n\n${esc(f.detail)}\n\n**Fix:** ${esc(f.fix)}\n\n${evidence}\n`;
}

export function reportToMarkdown(report: Report): string {
  const out: string[] = [];
  out.push(`# SiteRecon report: ${esc(report.domain)}`, "");
  out.push(`Scanned ${code(report.url)} on ${report.createdAt.slice(0, 10)}, ${report.pagesScanned.length} page${report.pagesScanned.length === 1 ? "" : "s"} read. Overall score: ${score(report.overallScore)}`, "");
  if (report.injectionFlags > 0) {
    out.push(`> This site's text contains ${report.injectionFlags} instruction-like passage${report.injectionFlags === 1 ? "" : "s"} aimed at AI tools. SiteRecon treated them as ordinary text.`, "");
  }

  if (report.summary) out.push("## Summary", "", esc(report.summary.verdict), "");

  out.push("## Scores", "", "| Module | Score |", "|---|---|");
  for (const m of report.modules) out.push(`| ${esc(MODULE_LABEL[m.module] ?? m.module)} | ${score(m.score)} |`);
  out.push("");

  if (report.summary) {
    const byId = new Map(report.modules.flatMap((m) => m.findings).map((f) => [f.id, f]));
    const groups: [string, string[]][] = [
      ["This week", report.summary.roadmap.thisWeek],
      ["This month", report.summary.roadmap.thisMonth],
      ["This quarter", report.summary.roadmap.thisQuarter],
    ];
    if (groups.some(([, ids]) => ids.length > 0)) {
      out.push("## Roadmap", "", "Every issue found, grouped by how much work the fix takes.", "");
      for (const [label, ids] of groups) {
        const lines = ids.flatMap((id) => (byId.get(id) ? [`- ${esc(byId.get(id)!.severity)}: ${esc(byId.get(id)!.title)}`] : []));
        if (lines.length > 0) out.push(`### ${label}`, "", ...lines, "");
      }
    }
  }

  out.push("## Top fixes", "");
  if (report.topFixes.length === 0) out.push("No issues found in the areas checked.", "");
  else report.topFixes.forEach((f, i) => out.push(findingBlock(f, i + 1)));

  if (report.fixKit.length > 0) {
    out.push("## Ready-to-paste fixes", "", "Built from what your own site says. Check each one before you use it.", "");
    for (const item of report.fixKit) {
      const f = fence(item.content);
      out.push(`### ${esc(item.title)}`, "", `Where it goes: ${code(item.filename)}`, "", `${f}${item.language}`, item.content, f, "", esc(item.note), "");
    }
  }

  if (report.ideas.length > 0) {
    out.push("## Marketing ideas", "", "AI-generated suggestions, each tied to a problem found above. Check them before acting.", "");
    for (const idea of report.ideas) out.push(`- **${esc(idea.title)}** (${esc(idea.effort)} effort): ${esc(idea.why)}`);
    out.push("");
  }

  if (report.competitors && report.competitors.rows.length > 0) {
    out.push("## Competitor comparison", "");
    if (report.competitors.note) out.push(esc(report.competitors.note), "");
    out.push("| Site | SEO | AI visibility | Social |", "|---|---|---|---|");
    const mine = (m: string) => score(report.modules.find((x) => x.module === m)?.score ?? null);
    const myPlatforms = Array.from(new Set((report.social?.profiles ?? []).filter((p) => p.kind === "profile").map((p) => p.platform)));
    out.push(`| ${esc(report.domain)} (you) | ${mine("technical")} | ${mine("geo")} | ${esc(myPlatforms.join(", ") || "none")} |`);
    for (const row of report.competitors.rows) {
      out.push(`| ${esc(row.domain)} | ${score(row.technical)} | ${score(row.geo)} | ${esc(row.platforms.join(", ") || "none")} |`);
    }
    out.push("");
    for (const gap of report.competitors.gaps) out.push(`- ${esc(gap)}`);
    out.push("");
  }

  if (report.social) {
    out.push("## Social media", "");
    if (report.social.profiles.length === 0) out.push("No social profiles are linked from the homepage.");
    for (const p of report.social.profiles) {
      const status = p.kind === "homepage" ? "placeholder link" : p.status.replace("_", " ");
      out.push(`- ${esc(p.platform)}: ${code(p.url)} (${esc(status)})${p.title ? ` ${esc(p.title)}` : ""}${p.note ? ` ${esc(p.note)}` : ""}`);
    }
    if (report.social.missing.length > 0) out.push("", `Not linked: ${esc(report.social.missing.join(", "))}.`);
    if (report.social.mentions) out.push("", `${report.social.mentions.hackerNews} Hacker News stories mention this site.`);
    out.push("");
  }

  if (report.couldntCheck.length > 0) {
    out.push("## Could not check", "");
    for (const c of report.couldntCheck) out.push(`- ${esc(c.what)}: ${esc(c.why)}`);
    out.push("");
  }

  const f = fence(report.fixPrompt);
  out.push("## Fix with Claude", "", "Paste this into Claude.", "", f, report.fixPrompt, f, "");
  return out.join("\n");
}
