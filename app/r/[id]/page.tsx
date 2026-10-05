import { notFound } from "next/navigation";
import Link from "next/link";
import { getDb } from "@/lib/db";
import { getReport } from "@/lib/report-store";
import ReportView from "@/components/ReportView";

export const dynamic = "force-dynamic";

export default async function ReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const report = /^[\w-]{1,64}$/.test(id) ? getReport(getDb(), id) : null;
  if (!report) notFound();
  return (
    <main className="mx-auto max-w-4xl px-4 py-16">
      <p className="mb-6 text-xs uppercase tracking-widest text-[var(--muted)]">
        <Link href="/">SiteRecon</Link> · saved report, kept for 30 days
      </p>
      <ReportView report={report} />
    </main>
  );
}
