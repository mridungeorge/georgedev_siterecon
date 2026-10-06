import type { Report } from "@/lib/pipeline/schemas";
import { reportToMarkdown } from "@/lib/report-markdown";

/**
 * A report as a Markdown file download. The domain comes from the audited site's address, so it is
 * reduced to letters, digits, dots and hyphens before it goes anywhere near a header, and the type is
 * pinned so a browser can never treat the file as a page.
 */
export function markdownDownload(report: Report): { body: string; headers: Record<string, string> } {
  const safe = report.domain.toLowerCase().replace(/[^a-z0-9.-]/g, "").replace(/^[.-]+|[.-]+$/g, "").slice(0, 80);
  return {
    body: reportToMarkdown(report),
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="siterecon-${safe || "report"}.md"`,
      "X-Content-Type-Options": "nosniff",
    },
  };
}
