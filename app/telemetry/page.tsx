import Link from "next/link";
import { getDb } from "@/lib/db";
import { summariseTelemetry } from "@/lib/telemetry-summary";

export const dynamic = "force-dynamic";
export const metadata = { title: "Telemetry · SiteRecon", description: "How long each scan step takes and how often it has to give up, across recent scans." };

export default function TelemetryPage() {
  const summary = summariseTelemetry(getDb());
  const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

  return (
    <main className="mx-auto max-w-3xl px-4 py-16 sm:py-24">
      <p className="mb-3 text-xs uppercase tracking-widest text-[var(--muted)]"><Link href="/">SiteRecon</Link> · telemetry</p>
      <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">How scans behave</h1>
      <p className="mt-4 text-[var(--muted)]">
        Timings and outcomes recorded with each report from the last 30 days. Nothing about the sites themselves appears here. Every outside
        provider runs on a free tier, so the cost of a report is zero; a step that could not run shows up as a warning rate.
      </p>

      {summary.scans === 0 ? (
        <p className="mt-10 text-sm text-[var(--muted)]">No scans with telemetry have been stored yet.</p>
      ) : (
        <>
          <dl className="mt-8 grid grid-cols-2 gap-3">
            <div className="border border-[var(--line)] bg-[var(--surface)] p-4">
              <dt className="text-xs uppercase tracking-widest text-[var(--muted)]">Scans</dt>
              <dd className="mt-1 text-2xl font-semibold tabular-nums">{summary.scans}</dd>
            </div>
            <div className="border border-[var(--line)] bg-[var(--surface)] p-4">
              <dt className="text-xs uppercase tracking-widest text-[var(--muted)]">Median scan</dt>
              <dd className="mt-1 text-2xl font-semibold tabular-nums">{seconds(summary.medianTotalMs)}</dd>
            </div>
          </dl>
          <table className="mt-8 w-full border-collapse text-sm">
            <thead className="text-left text-xs uppercase tracking-widest text-[var(--muted)]">
              <tr><th className="py-2 font-normal">Step</th><th className="py-2 text-right font-normal">Runs</th><th className="py-2 text-right font-normal">Median</th><th className="py-2 text-right font-normal">Slowest</th><th className="py-2 text-right font-normal">Gave up</th></tr>
            </thead>
            <tbody>
              {summary.steps.map((s) => (
                <tr key={s.step} className="border-b border-[var(--line)]">
                  <td className="py-2">{s.step}</td>
                  <td className="py-2 text-right tabular-nums">{s.runs}</td>
                  <td className="py-2 text-right tabular-nums">{seconds(s.medianMs)}</td>
                  <td className="py-2 text-right tabular-nums">{seconds(s.maxMs)}</td>
                  <td className="py-2 text-right tabular-nums">{Math.round(s.warnRate * 100)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </main>
  );
}
