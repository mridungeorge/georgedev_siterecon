"use client";
import { useState } from "react";
import Link from "next/link";
import type { Finding, FixKitItem, ModuleResult, Report } from "@/lib/pipeline/schemas";
import { reportToMarkdown } from "@/lib/report-markdown";

// Laid out like RepoRecon's report: numbered section labels, one collapsible card per finding with a
// severity bar, and the same colours. Every piece of text here comes from the audited site or a model,
// and is rendered as React text, never as HTML.

const MODULE_LABEL: Record<ModuleResult["module"], string> = {
  technical: "SEO", geo: "AI visibility", content: "Content and conversion",
  social: "Social", competitors: "Competitors", performance: "Speed",
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

  const order = [
    report.summary ? "summary" : null,
    "scores",
    hasRoadmap ? "roadmap" : null,
    "fixes",
    report.fixKit.length > 0 ? "kit" : null,
    report.ideas.length > 0 ? "ideas" : null,
    report.competitors && report.competitors.rows.length > 0 ? "competitors" : null,
    report.social ? "social" : null,
    "modules",
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

      <div>
        <SectionLabel n={n("fixes")}>Top fixes ({report.topFixes.length})</SectionLabel>
        <div className="mt-3 space-y-3">
          {report.topFixes.map((f, i) => <FindingCard key={f.id} f={f} open={i < 2} />)}
          {report.topFixes.length === 0 && <p className="text-sm text-muted">No issues found in the areas checked.</p>}
        </div>
      </div>

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
                <p className="mt-2 font-mono text-[11px] text-muted">addresses: {report.topFixes.find((f) => f.id === idea.findingId)?.title ?? idea.findingId}</p>
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
