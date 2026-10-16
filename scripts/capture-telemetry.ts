// Runs one real scan with no AI key and no PageSpeed key, and writes what it measured to a JSON file.
// Used to give the portfolio page real telemetry to show. Run it as:
//   npx tsx scripts/capture-telemetry.ts https://example.com/ content/sample-telemetry.json
import { writeFileSync } from "node:fs";
import { runScan } from "@/lib/pipeline/run";
import { safeFetch } from "@/lib/safe-fetch";
import { normalizeTargetUrl } from "@/lib/url-guard";

const [, , address, out] = process.argv;
if (!address || !out) {
  console.error("usage: tsx scripts/capture-telemetry.ts <address> <output.json>");
  process.exit(2);
}

async function main() {
  const target = new URL("/", normalizeTargetUrl(address));
  const started = Date.now();
  const report = await runScan(target, {
    fetchPage: (url, signal) => safeFetch(url, { signal }),
    emit: (e) => {
      if (e.event !== "step-start") console.log(`${e.event}  ${e.data.step}  ${"message" in e.data ? e.data.message : ""}`);
    },
  });

  const sample = {
    capturedAt: new Date().toISOString(),
    domain: report.domain,
    note: "One real scan with no AI key, no PageSpeed key and no browser service, so only the rule-based modules ran.",
    wallClockMs: Date.now() - started,
    overallScore: report.overallScore,
    aiReadiness: report.aiReadiness,
    pagesScanned: report.pagesScanned.length,
    telemetry: report.telemetry,
    modules: report.modules.map((m) => ({ module: m.module, score: m.score, status: m.status, findings: m.findings.length })),
    crawl: report.insights?.crawl ?? null,
    crawlFindings: (report.modules.find((m) => m.module === "crawl")?.findings ?? []).map((f) => ({ id: f.id, title: f.title, evidence: f.evidence.slice(0, 4) })),
  };
  writeFileSync(out, JSON.stringify(sample, null, 2) + "\n");
  console.log(`wrote ${out}: overall ${report.overallScore}, AI readiness ${report.aiReadiness?.score ?? "n/a"}, ${report.telemetry?.totalMs} ms`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
