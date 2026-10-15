"use client";
import { useState } from "react";
import Link from "next/link";
import type { Finding, FixKitItem, ModuleResult, Report } from "@/lib/pipeline/schemas";
import { reportToMarkdown } from "@/lib/report-markdown";
import { buildImpactMatrix } from "@/lib/impact-matrix";
import ImpactChart from "@/components/ImpactChart";

// Laid out like RepoRecon's report: numbered section labels, one collapsible card per finding with a
// severity bar, and the same colours. Every piece of text here comes from the audited site or a model,
// and is rendered as React text, never as HTML.

const MODULE_LABEL: Record<ModuleResult["module"], string> = {
  technical: "SEO", geo: "AI visibility", content: "Content and conversion", marketing: "Marketing",
  social: "Social", competitors: "Competitors", performance: "Speed", citation: "AI citation potential", crawl: "Crawlability",
};
const SEVERITY_COLOR: Record<Finding["severity"], string> = {
  critical: "text-alert", high: "text-orange-300", medium: "text-yellow-300", low: "text-accent",
};
const SEVERITY_BAR: Record<Finding["severity"], string> = {
  critical: "bg-alert", high: "bg-orange-400", medium: "bg-yellow-400", low: "bg-accent",
};

const scoreColor = (n: number | null) => (n === null ? "text-muted" : n >= 80 ? "text-live" : n >= 50 ? "text-ink" : "text-alert");
const button = "rounded border border-line bg-surface px-4 py-2 text-sm font-medium text-ink transition-colors hover:border-accent hover:text-accent";

function SectionLabel({ n, children }: { n: string; children: React.ReactNode }) {
  return (
    <h3 className="flex items-baseline gap-3 font-mono text-xs uppercase tracking-[0.2em] text-muted">
      <span className="text-accent">{n}</span>
      {children}
    </h3>
  );
}

function Score({ label, score, big }: { label: string; score: number | null; big?: boolean }) {
  return (
    <div className={`rounded border border-line bg-surface p-4 ${big ? "sm:col-span-1" : ""}`}>
      <div className="font-mono text-[11px] uppercase tracking-widest text-muted">{label}</div>
      <div className={`mt-1 font-semibold tabular-nums ${big ? "text-4xl" : "text-2xl"} ${scoreColor(score)}`}>{score === null ? "n/a" : score}</div>
    </div>
  );
}

function FindingCard({ f, open }: { f: Finding; open?: boolean }) {
  return (
    <details open={open} className="group overflow-hidden rounded border border-line bg-surface">
      <summary className="flex cursor-pointer flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2.5 text-sm marker:content-none">
        <span className={`h-full w-1 self-stretch rounded ${SEVERITY_BAR[f.severity]}`} />
        <span className={`font-semibold ${SEVERITY_COLOR[f.severity]}`}>{f.severity.toUpperCase()}</span>
        <span className="text-ink-soft">{f.title}</span>
        <span className="ml-auto font-mono text-[11px] text-muted">{MODULE_LABEL[f.module]} · {f.effort} effort</span>
      </summary>
      <div className="space-y-2 border-t border-line px-3 py-3">
        <p className="text-sm leading-relaxed text-ink-soft">{f.detail}</p>
        <p className="text-sm leading-relaxed text-ink"><span className="font-semibold text-accent">Fix:</span> {f.fix}</p>
        <ul className="space-y-1 font-mono text-xs text-muted">
          {f.evidence.map((e, i) => (
            <li key={i} className="break-words">
              evidence: {e.note}{e.quote ? <> — <code className="break-all text-ink-soft">{e.quote}</code></> : null} ({e.url})
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}

const GRADE_COLOR: Record<string, string> = { A: "text-live", B: "text-live", C: "text-ink", D: "text-orange-300", F: "text-alert" };

/** One ready-to-paste file or snippet, with a copy button. The content comes from the audited site, so it is shown as text. */
function FixKitCard({ item }: { item: FixKitItem }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(item.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="overflow-hidden rounded border border-line bg-surface">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-3 py-2.5">
        <span className="text-sm font-semibold text-ink">{item.title}</span>
        <span className="break-all font-mono text-[11px] text-muted">{item.filename}</span>
        <button onClick={copy} className="ml-auto rounded border border-line px-3 py-1 font-mono text-[11px] text-ink transition-colors hover:border-accent hover:text-accent">
          {copied ? "Copied!" : "Copy"}
        </button>
      </div>
      <pre className="max-h-72 overflow-auto bg-ground p-3 font-mono text-xs leading-relaxed text-ink-soft"><code>{item.content}</code></pre>
      <p className="px-3 py-2.5 text-xs leading-relaxed text-muted">{item.note}</p>
    </div>
  );
}

export default function ReportView({ report, permalink = true }: { report: Report; permalink?: boolean }) {
  const [copied, setCopied] = useState(false);

  const findingById = new Map(report.modules.flatMap((m) => m.findings).map((f) => [f.id, f]));
  const roadmapGroups = report.summary
    ? ([
        ["This week", "Quick fixes: low effort", report.summary.roadmap.thisWeek],
        ["This month", "Medium effort", report.summary.roadmap.thisMonth],
        ["This quarter", "Bigger jobs", report.summary.roadmap.thisQuarter],
      ] as const).map(([label, hint, ids]) => ({ label, hint, findings: ids.flatMap((id) => findingById.get(id) ?? []) }))
    : [];
  const hasRoadmap = roadmapGroups.some((g) => g.findings.length > 0);

  const matrix = buildImpactMatrix(report.modules.flatMap((m) => m.findings));
  const hasMatrix = matrix.quickWins.length + matrix.bigBets.length + matrix.fillIns.length + matrix.deprioritise.length > 0;
  const hasTelemetry = report.telemetry !== null && report.telemetry.steps.length > 0;

  const order = [
    report.aiReadiness ? "readiness" : null,
    report.summary ? "summary" : null,
    "scores",
    hasRoadmap ? "roadmap" : null,
    hasMatrix ? "matrix" : null,
    "fixes",
    report.pageTable.length > 0 ? "pages" : null,
    report.insights?.citation ? "citation" : null,
    report.insights?.vitals ? "vitals" : null,
    report.insights?.crawl ? "crawl" : null,
    report.fixKit.length > 0 ? "kit" : null,
    report.ideas.length > 0 ? "ideas" : null,
    report.competitors && report.competitors.rows.length > 0 ? "competitors" : null,
    report.social ? "social" : null,
    "modules",
    hasTelemetry ? "telemetry" : null,
    report.couldntCheck.length > 0 ? "couldnt" : null,
    "claude",
  ].filter((x): x is string => x !== null);
  const n = (id: string) => String(order.indexOf(id) + 1).padStart(2, "0");

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(report.fixPrompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };
  const saveFile = (content: string, type: string, extension: string) => {
    const blob = new Blob([content], { type });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `siterecon-${report.domain}.${extension}`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  // A link to claude.ai or chatgpt.com carries the prompt in its address, so it is capped, as RepoRecon caps its own.
  const linkPrompt = encodeURIComponent(report.fixPrompt.slice(0, 6000));
  const myPlatforms = Array.from(new Set((report.social?.profiles ?? []).filter((p) => p.kind === "profile").map((p) => p.platform)));
  const score = (m: string) => report.modules.find((x) => x.module === m)?.score ?? null;

  return (
    <div className="space-y-10">
      <p className="font-mono text-xs text-muted">
        Audit of <span className="break-all text-ink-soft">{report.url}</span> · {new Date(report.createdAt).toLocaleString()} · {report.pagesScanned.length} page
        {report.pagesScanned.length === 1 ? "" : "s"} read
      </p>

      {report.injectionFlags > 0 && (
        <div className="rounded border border-yellow-500/40 bg-yellow-500/10 px-4 py-3 text-sm text-yellow-200">
          {report.injectionFlags} instruction-like passage{report.injectionFlags === 1 ? "" : "s"} aimed at AI tools found in this site&apos;s text. SiteRecon
          treated {report.injectionFlags === 1 ? "it" : "them"} as ordinary text and did not follow {report.injectionFlags === 1 ? "it" : "them"}.
        </div>
      )}

      {report.aiReadiness && (
        <div>
          <SectionLabel n={n("readiness")}>AI Readiness Score</SectionLabel>
          <div className="mt-3 rounded border border-line bg-surface p-5">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
              <div className={`font-display text-7xl font-semibold leading-none tabular-nums ${scoreColor(report.aiReadiness.score)}`} aria-label={`AI readiness ${report.aiReadiness.score} out of 100`}>
                {report.aiReadiness.score}
              </div>
              <div>
                <div className="font-mono text-[11px] uppercase tracking-widest text-muted">{report.aiReadiness.band} · out of 100</div>
                <p className="mt-1 text-base leading-relaxed text-ink">{report.aiReadiness.verdict}</p>
              </div>
            </div>
            <ul className="mt-5 grid gap-2 sm:grid-cols-2">
              {report.aiReadiness.components.map((c) => (
                <li key={c.id} className="rounded border border-line px-3 py-2">
                  <div className="flex items-baseline justify-between gap-2 text-sm">
                    <span className="text-ink-soft">{c.label}</span>
                    <span className={`font-mono tabular-nums ${scoreColor(c.score)}`}>{c.score === null ? "not checked" : c.score}</span>
                  </div>
                  <div className="mt-1 font-mono text-[11px] text-muted">weight {c.weight} · {c.passed.length} passed · {c.failed.length} failed</div>
                </li>
              ))}
            </ul>
            <p className="mt-4 text-xs leading-relaxed text-muted">
              Computed in code from the checks below. No model sets this number, and it adds no checks of its own.
            </p>
          </div>
        </div>
      )}

      {report.summary && (
        <div>
          <SectionLabel n={n("summary")}>Summary</SectionLabel>
          <div className="mt-3 flex flex-col gap-5 rounded border border-line bg-surface p-5 sm:flex-row sm:items-center">
            <div className={`font-display text-7xl font-semibold leading-none ${report.summary.grade ? GRADE_COLOR[report.summary.grade] : "text-muted"}`} aria-label={`Grade ${report.summary.grade ?? "not available"}`}>
              {report.summary.grade ?? "–"}
            </div>
            <div className="space-y-3">
              <p className="text-base leading-relaxed text-ink">{report.summary.verdict}</p>
              <div className="flex flex-wrap gap-2 font-mono text-[11px] uppercase tracking-wide">
                {(["critical", "high", "medium", "low"] as const).filter((k) => report.summary!.counts[k] > 0).map((k) => (
                  <span key={k} className={`rounded border border-line px-2 py-1 ${SEVERITY_COLOR[k]}`}>{report.summary!.counts[k]} {k}</span>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      <div>
        <SectionLabel n={n("scores")}>Scores</SectionLabel>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Score label="Overall" score={report.overallScore} big />
          {report.modules.map((m) => <Score key={m.module} label={MODULE_LABEL[m.module]} score={m.score} />)}
        </div>
      </div>

      {hasRoadmap && (
        <div>
          <SectionLabel n={n("roadmap")}>Roadmap</SectionLabel>
          <p className="mt-2 text-sm leading-relaxed text-ink-soft">Every issue found, grouped by how much work the fix takes. Start at the top.</p>
          <div className="mt-3 grid gap-3 lg:grid-cols-3">
            {roadmapGroups.filter((g) => g.findings.length > 0).map((g) => (
              <div key={g.label} className="rounded border border-line bg-surface p-4">
                <div className="flex items-baseline justify-between gap-2">
                  <h4 className="text-sm font-semibold text-ink">{g.label}</h4>
                  <span className="font-mono text-[11px] text-muted">{g.findings.length} · {g.hint}</span>
                </div>
                <ul className="mt-3 space-y-2">
                  {g.findings.map((f) => (
                    <li key={f.id} className="flex gap-2 text-sm leading-snug text-ink-soft">
                      <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${SEVERITY_BAR[f.severity]}`} aria-label={`${f.severity} severity`} />
                      <span>{f.title}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      )}

      {hasMatrix && (
        <div>
          <SectionLabel n={n("matrix")}>Impact vs effort</SectionLabel>
          <p className="mt-2 text-sm leading-relaxed text-ink-soft">High impact is critical or high severity. Start with the top left.</p>
          <ImpactChart findings={report.modules.flatMap((m) => m.findings)} />
          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            {([
              ["Quick wins", "High impact, low or medium effort", matrix.quickWins],
              ["Big bets", "High impact, high effort", matrix.bigBets],
              ["Fill-ins", "Lower impact, low or medium effort", matrix.fillIns],
              ["Deprioritise", "Lower impact, high effort", matrix.deprioritise],
            ] as const).map(([label, hint, list]) => (
              <div key={label} className="rounded border border-line bg-surface p-4">
                <div className="flex items-baseline justify-between gap-2">
                  <h4 className="text-sm font-semibold text-ink">{label}</h4>
                  <span className="font-mono text-[11px] text-muted">{list.length} · {hint}</span>
                </div>
                <ul className="mt-3 space-y-2">
                  {list.map((f) => (
                    <li key={f.id} className="flex gap-2 text-sm leading-snug text-ink-soft">
                      <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${SEVERITY_BAR[f.severity]}`} aria-label={`${f.severity} severity`} />
                      <span>{f.title}</span>
                    </li>
                  ))}
                  {list.length === 0 && <li className="text-sm text-muted">Nothing here.</li>}
                </ul>
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <SectionLabel n={n("fixes")}>Top fixes ({report.topFixes.length})</SectionLabel>
        <div className="mt-3 space-y-3">
          {report.topFixes.map((f, i) => <FindingCard key={f.id} f={f} open={i < 2} />)}
          {report.topFixes.length === 0 && <p className="text-sm text-muted">No issues found in the areas checked.</p>}
        </div>
      </div>

      {report.pageTable.length > 0 && (
        <div>
          <SectionLabel n={n("pages")}>Pages read ({report.pageTable.length})</SectionLabel>
          <p className="mt-2 text-sm leading-relaxed text-ink-soft">Every page SiteRecon read, and what each says about itself. Cells in red are worth fixing.</p>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[40rem] text-left text-xs">
              <thead className="font-mono text-muted">
                <tr>
                  <th className="py-1 pr-4 font-normal">Page</th><th className="py-1 pr-4 font-normal">Title</th><th className="py-1 pr-4 font-normal">H1</th>
                  <th className="py-1 pr-4 font-normal">Words</th><th className="py-1 font-normal">Issues</th>
                </tr>
              </thead>
              <tbody className="font-mono text-ink-soft">
                {report.pageTable.map((p) => {
                  let path = p.url;
                  try {
                    const u = new URL(p.url);
                    path = u.pathname + u.search || "/";
                  } catch {
                    // keep the full address
                  }
                  return (
                    <tr key={p.url} className="border-t border-line align-top">
                      <td className="max-w-[14rem] break-all py-1.5 pr-4 text-ink">{path}</td>
                      <td className={`max-w-[18rem] py-1.5 pr-4 ${p.title ? "" : "text-alert"}`}>{p.title || "none"}</td>
                      <td className={`py-1.5 pr-4 tabular-nums ${p.h1 === 1 ? "" : "text-alert"}`}>{p.h1}</td>
                      <td className={`py-1.5 pr-4 tabular-nums ${p.words >= 100 ? "" : "text-alert"}`}>{p.words}</td>
                      <td className={`py-1.5 tabular-nums ${p.issues === 0 ? "text-live" : ""}`}>{p.issues}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {report.insights?.citation && (
        <div>
          <SectionLabel n={n("citation")}>AI citation potential</SectionLabel>
          <p className="mt-2 text-sm leading-relaxed text-ink-soft">
            How easy it is for an AI answer engine to lift a clear, attributable passage from each page. Scored by fixed rules over the HTML; no model sets these numbers.
          </p>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[34rem] text-left text-xs">
              <thead className="font-mono text-muted">
                <tr><th className="py-1 pr-4 font-normal">Page</th><th className="py-1 pr-4 font-normal">Score</th><th className="py-1 font-normal">Criteria that failed</th></tr>
              </thead>
              <tbody className="font-mono text-ink-soft">
                {report.insights.citation.pages.map((p) => {
                  let path = p.url;
                  try {
                    const u = new URL(p.url);
                    path = u.pathname + u.search || "/";
                  } catch {
                    // keep the full address
                  }
                  const failed = Object.entries(p.criteria).filter(([, s]) => s === "fail" || s === "partial").map(([id, s]) => (s === "partial" ? `${id} (partly)` : id));
                  return (
                    <tr key={p.url} className="border-t border-line align-top">
                      <td className="max-w-[14rem] break-all py-1.5 pr-4 text-ink">{path}</td>
                      <td className={`py-1.5 pr-4 tabular-nums ${scoreColor(p.score)}`}>{p.score === null ? "n/a" : p.score}</td>
                      <td className="py-1.5">{failed.length === 0 ? <span className="text-live">none</span> : failed.join(", ")}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <div className="rounded border border-line bg-surface p-4">
              <h4 className="text-sm font-semibold text-ink">What an AI could lift today</h4>
              <dl className="mt-2 space-y-2 text-sm text-ink-soft">
                <div><dt className="font-mono text-[11px] uppercase tracking-widest text-muted">Named as</dt><dd>{report.insights.citation.extractable.entity ?? "not found"}</dd></div>
                <div><dt className="font-mono text-[11px] uppercase tracking-widest text-muted">Defined as</dt><dd>{report.insights.citation.extractable.definition ?? "no defining sentence found"}</dd></div>
                <div><dt className="font-mono text-[11px] uppercase tracking-widest text-muted">Concrete facts</dt><dd>{report.insights.citation.extractable.facts.length > 0 ? report.insights.citation.extractable.facts.join(", ") : "none found"}</dd></div>
              </dl>
            </div>
            <div className="rounded border border-line bg-surface p-4">
              <h4 className="text-sm font-semibold text-ink">AI answer-extraction simulation</h4>
              {report.insights.citation.aiExtraction.length === 0 ? (
                <p className="mt-2 text-sm text-muted">Not run: it needs the AI service, and every answer must quote the page.</p>
              ) : (
                <ul className="mt-2 space-y-2 text-sm text-ink-soft">
                  {report.insights.citation.aiExtraction.map((item) => (
                    <li key={item.id}>
                      <span className={item.extractable ? "text-live" : "text-alert"}>{item.extractable ? "✓" : "✗"}</span>{" "}
                      <span className="font-semibold text-ink">{item.kind === "keyword" ? `Keyword: ${item.label}` : item.label}</span>
                      {item.quote ? <> — <code className="break-words text-xs">{item.quote}</code></> : null}
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-3 text-xs text-muted">An unscored opinion. It counts only with a quote taken from the page.</p>
            </div>
            {report.insights.citation.authority && (
              <div className="rounded border border-line bg-surface p-4 sm:col-span-2">
                <h4 className="text-sm font-semibold text-ink">Signals that the site is known beyond its own pages</h4>
                <dl className="mt-2 grid gap-2 text-sm text-ink-soft sm:grid-cols-3">
                  <div><dt className="font-mono text-[11px] uppercase tracking-widest text-muted">Domain rank (Open PageRank)</dt><dd>{report.insights.citation.authority.domainRank === null ? "not measured" : `${report.insights.citation.authority.domainRank} of 10`}</dd></div>
                  <div><dt className="font-mono text-[11px] uppercase tracking-widest text-muted">Wikidata entry</dt><dd>{report.insights.citation.authority.wikidata === null ? "not checked" : report.insights.citation.authority.wikidata ? "found" : "none with this name"}</dd></div>
                  <div><dt className="font-mono text-[11px] uppercase tracking-widest text-muted">Hacker News stories</dt><dd>{report.insights.citation.authority.hackerNews === null ? "not read" : report.insights.citation.authority.hackerNews}</dd></div>
                </dl>
                <p className="mt-3 text-xs text-muted">These affect the citation score but never raise a finding: there is nothing on your pages to fix.</p>
              </div>
            )}
          </div>
        </div>
      )}

      {report.insights?.vitals && (
        <div>
          <SectionLabel n={n("vitals")}>Core Web Vitals, mapped</SectionLabel>
          <p className="mt-2 text-sm leading-relaxed text-ink-soft">
            {report.insights.vitals.source === "pagespeed"
              ? "One mobile lab run from Google PageSpeed. The element names and files below come from that run."
              : "Measured by the audit's own headless browser, because no PageSpeed run was available. A lab measurement of one load, so it names the kind of element but not the file."}
          </p>
          <ul className="mt-3 space-y-2 text-sm">
            <li className="rounded border border-line bg-surface px-3 py-2">
              <span className="font-semibold text-ink">LCP {(report.insights.vitals.lcp.ms / 1000).toFixed(1)} s</span>
              <span className="ml-2 break-all font-mono text-xs text-muted">
                {report.insights.vitals.lcp.element ? `element ${report.insights.vitals.lcp.element}` : "element not reported"}
                {report.insights.vitals.lcp.resource ? ` · file ${report.insights.vitals.lcp.resource}` : ""}
              </span>
            </li>
            <li className="rounded border border-line bg-surface px-3 py-2">
              <span className="font-semibold text-ink">CLS {report.insights.vitals.cls.value.toFixed(2)}</span>
              <span className="ml-2 break-all font-mono text-xs text-muted">
                {report.insights.vitals.cls.shifts.length > 0 ? report.insights.vitals.cls.shifts.map((s) => `${s.selector} (${s.score.toFixed(2)})`).join(", ") : "no shifting elements reported"}
              </span>
            </li>
            <li className="rounded border border-line bg-surface px-3 py-2">
              <span className="font-semibold text-ink">INP {report.insights.vitals.inp ? `${report.insights.vitals.inp.ms} ms` : "not available"}</span>
              <span className="ml-2 font-mono text-xs text-muted">
                {report.insights.vitals.inp ? `${report.insights.vitals.inp.rating}, ${report.insights.vitals.inp.source === "field" ? "from real Chrome users" : "from one synthetic key press and click in the audit's browser"}` : "no field data from Google and no interaction was recorded in the lab"}
              </span>
            </li>
            {report.insights.vitals.blockers.length > 0 && (
              <li className="rounded border border-line bg-surface px-3 py-2">
                <span className="font-semibold text-ink">Render-blocking files</span>
                <ul className="mt-1 space-y-0.5 font-mono text-xs text-muted">
                  {report.insights.vitals.blockers.map((b) => <li key={b.url} className="break-all">{b.url} · about {b.wastedMs} ms</li>)}
                </ul>
              </li>
            )}
            {report.insights.vitals.heavyScripts.length > 0 && (
              <li className="rounded border border-line bg-surface px-3 py-2">
                <span className="font-semibold text-ink">Heaviest scripts</span>
                <ul className="mt-1 space-y-0.5 font-mono text-xs text-muted">
                  {report.insights.vitals.heavyScripts.map((b) => <li key={b.url} className="break-all">{b.url} · {b.ms} ms</li>)}
                </ul>
              </li>
            )}
          </ul>
        </div>
      )}

      {report.insights?.crawl && (
        <div>
          <SectionLabel n={n("crawl")}>Crawlability and rendering</SectionLabel>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Score label="Pages OK" score={report.insights.crawl.statusClasses.ok} />
            <Score label="Redirected" score={report.insights.crawl.statusClasses.redirected} />
            <Score label="4xx" score={report.insights.crawl.statusClasses.clientError} />
            <Score label="5xx" score={report.insights.crawl.statusClasses.serverError} />
            {report.insights.crawl.statusClasses.unreachable > 0 && <Score label="Unreachable" score={report.insights.crawl.statusClasses.unreachable} />}
          </div>
          <p className="mt-2 text-xs leading-relaxed text-muted">
            {report.insights.crawl.coverage
              ? `${report.insights.crawl.coverage.sitemapUrls} pages in the sitemap, ${report.insights.crawl.coverage.fetched} fetched beyond the ones read first.${report.insights.crawl.coverage.complete ? "" : " The sitemap is larger than the crawl limit, so counts cover only part of it."}`
              : "Only the pages read first are counted."}
            {report.insights.crawl.orphanCheck === "incomplete" ? " Orphan pages were not checked, because that needs every sitemap page." : ""}
          </p>
          {report.insights.crawl.renderDiff.length > 0 ? (
            <table className="mt-4 w-full max-w-md text-left text-xs">
              <thead className="font-mono text-muted"><tr><th className="py-1 font-normal">What a bot is served vs a browser</th><th className="py-1 text-right font-normal">HTML</th><th className="py-1 text-right font-normal">Browser</th></tr></thead>
              <tbody className="font-mono text-ink-soft">
                {report.insights.crawl.renderDiff.map((d) => (
                  <tr key={d.label} className="border-t border-line">
                    <td className="py-1.5">{d.label}</td>
                    <td className="py-1.5 text-right tabular-nums">{d.raw}</td>
                    <td className={`py-1.5 text-right tabular-nums ${d.rendered > d.raw ? "text-alert" : ""}`}>{d.rendered}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="mt-3 text-sm text-muted">The browser step did not run, so raw and rendered HTML were not compared.</p>
          )}
        </div>
      )}

      {report.fixKit.length > 0 && (
        <div>
          <SectionLabel n={n("kit")}>Ready-to-paste fixes</SectionLabel>
          <p className="mt-2 text-sm leading-relaxed text-ink-soft">Built from what your own site says, not written by an AI. Check each one before you use it.</p>
          <div className="mt-3 space-y-3">{report.fixKit.map((item) => <FixKitCard key={item.id} item={item} />)}</div>
        </div>
      )}

      {report.ideas.length > 0 && (
        <div>
          <SectionLabel n={n("ideas")}>Marketing ideas</SectionLabel>
          <p className="mt-2 text-sm leading-relaxed text-ink-soft">AI-generated suggestions, each tied to a problem found above. Check them before acting.</p>
          <ul className="mt-3 space-y-3">
            {report.ideas.map((idea, i) => (
              <li key={i} className="rounded border border-line bg-surface px-3 py-3">
                <div className="flex items-baseline justify-between gap-3">
                  <h4 className="text-sm font-semibold text-ink">{idea.title}</h4>
                  <span className="shrink-0 font-mono text-[11px] text-muted">{idea.effort} effort</span>
                </div>
                <p className="mt-1 text-sm leading-relaxed text-ink-soft">{idea.why}</p>
                <p className="mt-2 font-mono text-[11px] text-muted">addresses: {findingById.get(idea.findingId)?.title ?? idea.findingId}</p>
              </li>
            ))}
          </ul>
        </div>
      )}

      {report.competitors && report.competitors.rows.length > 0 && (
        <div>
          <SectionLabel n={n("competitors")}>Competitor comparison</SectionLabel>
          {report.competitors.note && <p className="mt-2 text-sm leading-relaxed text-ink-soft">{report.competitors.note}</p>}
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[32rem] text-left text-xs">
              <thead className="font-mono text-muted">
                <tr><th className="py-1 pr-4 font-normal">Site</th><th className="py-1 pr-4 font-normal">SEO</th><th className="py-1 pr-4 font-normal">AI visibility</th><th className="py-1 font-normal">Social</th></tr>
              </thead>
              <tbody className="font-mono text-ink-soft">
                <tr className="border-t border-line text-ink">
                  <td className="py-1.5 pr-4">{report.domain} (you)</td>
                  <td className="py-1.5 pr-4 tabular-nums">{score("technical") ?? "n/a"}</td>
                  <td className="py-1.5 pr-4 tabular-nums">{score("geo") ?? "n/a"}</td>
                  <td className="py-1.5">{myPlatforms.join(", ") || "none"}</td>
                </tr>
                {report.competitors.rows.map((row) => (
                  <tr key={row.domain} className="border-t border-line">
                    <td className="py-1.5 pr-4 break-all">{row.domain}</td>
                    <td className="py-1.5 pr-4 tabular-nums">{row.technical ?? "n/a"}</td>
                    <td className="py-1.5 pr-4 tabular-nums">{row.geo ?? "n/a"}</td>
                    <td className="py-1.5">{row.platforms.join(", ") || "none"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-ink-soft">{report.competitors.gaps.map((gap, i) => <li key={i}>{gap}</li>)}</ul>
          {report.competitors.rows.some((r) => r.headline || r.description) && (
            <div className="mt-5">
              <p className="font-mono text-xs text-muted">How they position themselves</p>
              <ul className="mt-2 space-y-3 text-sm">
                {[
                  { domain: `${report.domain} (you)`, headline: report.pageTable[0]?.headline ?? "", description: report.pageTable[0]?.description ?? "" },
                  ...report.competitors.rows,
                ].map((r) => (
                  <li key={r.domain} className="border-t border-line pt-2">
                    <span className="font-mono text-xs text-ink break-all">{r.domain}</span>
                    {r.headline && <p className="mt-0.5 text-ink">{r.headline}</p>}
                    {r.description && <p className="mt-0.5 text-ink-soft">{r.description}</p>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {report.social && (
        <div>
          <SectionLabel n={n("social")}>Social media</SectionLabel>
          <p className="mt-2 text-sm leading-relaxed text-ink-soft">
            {report.social.readerUsed ? "Public pages only. Profiles that need a login are not read." : "Links found on the site. The profile pages themselves were not opened."}
            {report.social.mentions ? ` ${report.social.mentions.hackerNews} Hacker News stories mention this site.` : ""}
          </p>
          {report.social.profiles.length === 0 ? (
            <p className="mt-3 text-sm text-muted">No social profiles are linked from the homepage.</p>
          ) : (
            <ul className="mt-3 space-y-2 text-sm">
              {report.social.profiles.map((p) => (
                <li key={p.url} className="flex flex-wrap items-baseline gap-x-3 rounded border border-line bg-surface px-3 py-2">
                  <span className="font-semibold text-ink">{p.platform}</span>
                  <span className="break-all font-mono text-xs text-muted">{p.url}</span>
                  {(p.title || p.note) && <span className="w-full text-xs text-ink-soft">{[p.title, p.note].filter(Boolean).join(" · ")}</span>}
                  <span className={`ml-auto font-mono text-[11px] uppercase tracking-wide ${p.status === "not_found" ? "text-alert" : p.status === "found" ? "text-live" : "text-muted"}`}>
                    {p.kind === "homepage" ? "placeholder link" : p.status.replace("_", " ")}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {report.social.missing.length > 0 && <p className="mt-3 text-sm text-ink-soft">Not linked: {report.social.missing.join(", ")}.</p>}
        </div>
      )}

      <div>
        <SectionLabel n={n("modules")}>Every check</SectionLabel>
        <div className="mt-3 space-y-3">
          {report.modules.map((m) => (
            <details key={m.module} className="overflow-hidden rounded border border-line bg-surface">
              <summary className="flex cursor-pointer items-center gap-3 px-3 py-2.5 text-sm marker:content-none">
                <span className="font-semibold text-ink">{MODULE_LABEL[m.module]}</span>
                <span className={`font-mono tabular-nums ${scoreColor(m.score)}`}>{m.score ?? "n/a"}</span>
                <span className="ml-auto font-mono text-[11px] text-muted">
                  {m.status === "failed" ? "could not run" : `${m.passed.length} passed · ${m.findings.length} issue${m.findings.length === 1 ? "" : "s"}`}
                </span>
              </summary>
              {m.findings.length > 0 && (
                <div className="space-y-3 border-t border-line p-3">{m.findings.map((f) => <FindingCard key={f.id} f={f} />)}</div>
              )}
            </details>
          ))}
        </div>
      </div>

      {hasTelemetry && report.telemetry && (
        <div>
          <SectionLabel n={n("telemetry")}>Scan telemetry</SectionLabel>
          <p className="mt-2 text-sm leading-relaxed text-ink-soft">
            {(report.telemetry.totalMs / 1000).toFixed(1)} s in total. Cost ${report.telemetry.estimatedCostUsd.toFixed(2)}: every provider runs on a free tier.
          </p>
          {Object.keys(report.telemetry.calls).length > 0 && (
            <p className="mt-1 font-mono text-xs text-muted">
              requests: {Object.entries(report.telemetry.calls).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(" · ") || "none"}
            </p>
          )}
          <ul className="mt-3 space-y-1.5 font-mono text-xs">
            {report.telemetry.steps.map((st) => {
              const pct = report.telemetry!.totalMs > 0 ? Math.max(2, Math.round((st.ms / report.telemetry!.totalMs) * 100)) : 2;
              return (
                <li key={st.step} className="grid grid-cols-[6.5rem_1fr_4rem] items-center gap-3">
                  <span className="text-ink-soft">{st.step}</span>
                  <span className="h-2 overflow-hidden rounded bg-line"><span className={`block h-full ${st.outcome === "done" ? "bg-live" : "bg-yellow-400"}`} style={{ width: `${pct}%` }} /></span>
                  <span className="text-right tabular-nums text-muted">{(st.ms / 1000).toFixed(1)} s</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {report.couldntCheck.length > 0 && (
        <div>
          <SectionLabel n={n("couldnt")}>Could not check</SectionLabel>
          <ul className="mt-3 space-y-1 font-mono text-xs text-muted">
            {report.couldntCheck.map((c, i) => <li key={i} className="break-words"><span className="text-ink-soft">{c.what}</span>: {c.why}</li>)}
          </ul>
        </div>
      )}

      <div>
        <SectionLabel n={n("claude")}>Fix with Claude</SectionLabel>
        <p className="mt-2 text-sm leading-relaxed text-ink-soft">A prompt built from the findings above. Paste it into Claude, or ChatGPT, to get the exact changes.</p>
        <textarea
          readOnly value={report.fixPrompt} rows={10}
          className="mt-3 w-full rounded border border-line bg-ground p-2 font-mono text-xs text-ink-soft focus:border-accent focus:outline-none"
        />
        <div className="mt-3 flex flex-wrap gap-2">
          <button onClick={copy} className="rounded bg-accent px-4 py-2 text-sm font-medium text-ground transition-colors hover:bg-ink">{copied ? "Copied!" : "Copy prompt"}</button>
          <a href={`https://claude.ai/new?q=${linkPrompt}`} target="_blank" rel="noopener noreferrer" className={button}>Open in Claude</a>
          <a href={`https://chatgpt.com/?q=${linkPrompt}`} target="_blank" rel="noopener noreferrer" className={button}>Open in ChatGPT</a>
          <button onClick={() => saveFile(reportToMarkdown(report), "text/markdown", "md")} className={button}>Download Markdown</button>
          <button onClick={() => saveFile(JSON.stringify(report, null, 2), "application/json", "json")} className={button}>Download JSON</button>
          {permalink && <Link href={`/r/${report.id}`} className={button}>Permalink</Link>}
        </div>
        <p className="mt-2 font-mono text-xs text-muted">If a link opens a blank chat, the prompt is already on your clipboard once you press Copy, so just paste it.</p>
      </div>
    </div>
  );
}
