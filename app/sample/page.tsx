import Link from "next/link";
import ReportView from "@/components/ReportView";
import { ReportSchema } from "@/lib/pipeline/schemas";
import raw from "@/content/sample-report.json";

// A real report, generated ahead of time, so a visitor can see what SiteRecon produces without waiting
// for a scan, and so there is something to show when the daily limit has been reached. Parsing it here
// means a report that no longer matches the schema fails the build instead of showing a broken page.
const report = ReportSchema.parse(raw);

export const metadata = { title: "Sample report · SiteRecon", description: "A real SiteRecon report, generated ahead of time." };

export default function SamplePage() {
  return (
    <div className="min-h-screen bg-ground px-6 py-16">
      <main className="mx-auto w-full max-w-4xl">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-muted">
          <Link href="/" className="hover:text-accent">SiteRecon</Link> · sample report
        </p>
        <div className="mt-4 rounded border border-line bg-surface px-4 py-3 text-sm text-ink-soft">
          This is a real scan of <span className="text-ink">{report.domain}</span>, generated on {report.createdAt.slice(0, 10)} and saved. It is not live: your own scan
          will read your own site just now. <Link href="/" className="text-accent underline">Run your own audit</Link>
        </div>
        <div className="mt-8">
          <ReportView report={report} permalink={false} />
        </div>
      </main>
    </div>
  );
}
