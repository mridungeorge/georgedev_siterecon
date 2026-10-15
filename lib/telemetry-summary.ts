import type { DatabaseSync } from "node:sqlite";
import { ReportSchema } from "@/lib/pipeline/schemas";
import { REPORT_TTL_MS } from "@/lib/report-store";
import { STEPS } from "@/lib/pipeline/steps";

// Aggregates the telemetry stored with each report (the last 30 days). It reads reports the app
// already keeps, so it adds no table, and it reports only timings and outcomes, never site content.

export interface StepStats { step: string; runs: number; medianMs: number; maxMs: number; warnRate: number }
export interface TelemetrySummary { scans: number; medianTotalMs: number; steps: StepStats[] }

const median = (values: number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
};

export function summariseTelemetry(db: DatabaseSync, now: number = Date.now()): TelemetrySummary {
  const rows = db.prepare("SELECT json FROM reports WHERE created_at > ?").all(now - REPORT_TTL_MS) as { json: string }[];
  const totals: number[] = [];
  const byStep = new Map<string, { ms: number[]; warned: number }>();

  for (const row of rows) {
    let telemetry;
    try {
      telemetry = ReportSchema.parse(JSON.parse(row.json)).telemetry;
    } catch {
      continue;
    }
    if (!telemetry || telemetry.steps.length === 0) continue;
    totals.push(telemetry.totalMs);
    for (const s of telemetry.steps) {
      const entry = byStep.get(s.step) ?? { ms: [], warned: 0 };
      entry.ms.push(s.ms);
      if (s.outcome === "warned") entry.warned += 1;
      byStep.set(s.step, entry);
    }
  }

  const order = (step: string) => {
    const i = (STEPS as readonly string[]).indexOf(step);
    return i === -1 ? STEPS.length : i;
  };
  const steps: StepStats[] = [...byStep]
    .map(([step, e]) => ({ step, runs: e.ms.length, medianMs: median(e.ms), maxMs: Math.max(...e.ms), warnRate: e.warned / e.ms.length }))
    .sort((a, b) => order(a.step) - order(b.step));
  return { scans: totals.length, medianTotalMs: median(totals), steps };
}
