"use client";
import { useState } from "react";
import Link from "next/link";
import type { Finding, ModuleResult, Report } from "@/lib/pipeline/schemas";

const MODULE_LABEL: Record<ModuleResult["module"], string> = {
  technical: "SEO", geo: "AI visibility", content: "Content and conversion",
  social: "Social", competitors: "Competitors", performance: "Performance",
};
const SEVERITY_COLOR: Record<Finding["severity"], string> = {
  critical: "var(--bad)", high: "var(--bad)", medium: "var(--warn)", low: "var(--muted)",
};

function scoreColor(score: number | null) {
  if (score === null) return "var(--muted)";
  return score >= 80 ? "var(--live)" : score >= 50 ? "var(--warn)" : "var(--bad)";
}

function Score({ label, score }: { label: string; score: number | null }) {
  return (
    <div className="border border-[var(--line)] bg-[var(--surface)] p-4">
      <div className="text-xs uppercase tracking-wide text-[var(--muted)]">{label}</div>
      <div className="mt-1 text-3xl font-semibold tabular-nums" style={{ color: scoreColor(score) }}>
        {score === null ? "n/a" : score}
      </div>
    </div>
  );
}

// Everything below renders text from the audited site as React text nodes, never as HTML.
function FindingCard({ f }: { f: Finding }) {
  return (
    <li className="border border-[var(--line)] p-4">
      <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs uppercase tracking-wide">
        <span style={{ color: SEVERITY_COLOR[f.severity] }}>{f.severity}</span>
        <span className="text-[var(--muted)]">{MODULE_LABEL[f.module]}</span>
        <span className="text-[var(--muted)]">{f.effort} effort</span>
      </div>
      <h4 className="font-semibold">{f.title}</h4>
      <p className="mt-1 text-sm text-[var(--muted)]">{f.detail}</p>
      <p className="mt-2 text-sm"><span className="font-medium">Fix:</span> {f.fix}</p>
      <ul className="mt-2 space-y-1 text-xs text-[var(--muted)]">
        {f.evidence.map((e, i) => (
          <li key={i} className="break-words">
            Evidence: {e.note}{e.quote ? <> — <code className="break-all">{e.quote}</code></> : null} ({e.url})
          </li>
        ))}
      </ul>
    </li>
  );
}

export default function ReportView({ report }: { report: Report }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(report.fixPrompt);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  const download = () => {
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `siterecon-${report.domain}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="space-y-10">
      <header>
        <p className="text-sm text-[var(--muted)]">
          Audit of <span className="break-all text-[var(--ink)]">{report.url}</span> · {new Date(report.createdAt).toLocaleString()} ·{" "}
          {report.pagesScanned.length} page{report.pagesScanned.length === 1 ? "" : "s"} read
        </p>
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Score label="Overall" score={report.overallScore} />
          {report.modules.map((m) => <Score key={m.module} label={MODULE_LABEL[m.module]} score={m.score} />)}
        </div>
      </header>

      <section>
        <h3 className="mb-3 text-xl font-semibold">Top fixes</h3>
        {report.topFixes.length === 0
          ? <p className="text-[var(--muted)]">No issues found in the areas checked.</p>
          : <ol className="space-y-3">{report.topFixes.map((f) => <FindingCard key={f.id} f={f} />)}</ol>}
      </section>

      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-xl font-semibold">Fix with Claude</h3>
          <div className="flex gap-2">
            <button onClick={copy} className="border border-[var(--ink)] bg-[var(--ink)] px-4 py-2 text-sm text-[var(--ground)]">
              {copied ? "Copied" : "Copy prompt"}
            </button>
            <button onClick={download} className="border border-[var(--line)] px-4 py-2 text-sm">Download JSON</button>
            <Link href={`/r/${report.id}`} className="border border-[var(--line)] px-4 py-2 text-sm">Permalink</Link>
          </div>
        </div>
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words border border-[var(--line)] bg-[var(--surface)] p-4 text-xs">
          {report.fixPrompt}
        </pre>
      </section>

      {report.modules.map((m) => (
        <section key={m.module}>
          <h3 className="mb-1 text-xl font-semibold">{MODULE_LABEL[m.module]}</h3>
          <p className="mb-3 text-sm text-[var(--muted)]">
            {m.status === "failed"
              ? "This part of the audit could not run."
              : `${m.passed.length} checks passed, ${m.findings.length} issues found.`}
          </p>
          <ul className="space-y-3">{m.findings.map((f) => <FindingCard key={f.id} f={f} />)}</ul>
        </section>
      ))}

      {report.couldntCheck.length > 0 && (
        <section>
          <h3 className="mb-3 text-xl font-semibold">Couldn&apos;t check</h3>
          <ul className="space-y-1 text-sm text-[var(--muted)]">
            {report.couldntCheck.map((c, i) => <li key={i} className="break-words">{c.what}: {c.why}</li>)}
          </ul>
        </section>
      )}
    </div>
  );
}
