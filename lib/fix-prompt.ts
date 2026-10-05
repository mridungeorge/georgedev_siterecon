import type { Finding } from "@/lib/pipeline/schemas";

/**
 * Built in code from the findings, the same way RepoRecon's buildFixPrompt is, so the
 * prompt can only contain what the audit actually found.
 */
export function buildFixPrompt(input: { url: string; findings: Finding[] }): string {
  if (input.findings.length === 0) {
    return `I ran a marketing and SEO audit on ${input.url} and it found no issues in the areas it checked. Suggest three experiments that could improve its search visibility or conversion rate.`;
  }

  const list = input.findings
    .map((f, i) => {
      const evidence = f.evidence
        .map((e) => `   Evidence: ${[e.note, e.quote ? `"${e.quote}"` : "", `(${e.url})`].filter(Boolean).join(" ")}`)
        .join("\n");
      return `${i + 1}. [${f.severity.toUpperCase()}] ${f.title}\n   ${f.detail}\n${evidence}\n   Suggested fix: ${f.fix}`;
    })
    .join("\n\n");

  return `I ran a marketing and SEO audit on ${input.url}. It found the issues below, most important first. For each one: explain the impact in one or two sentences, then give the exact change to make (HTML, meta tags, JSON-LD, robots.txt lines or copy), ready to paste. Do not change anything unrelated. If a fix depends on my platform or framework, ask me which one I use before guessing.\n\n${list}`;
}
