"use client";
import { useState } from "react";
import Link from "next/link";
import { useScanStream } from "@/lib/useScanStream";
// Import from steps, not run: run pulls in server-only code and would break the client build.
import { STEPS, type StepName } from "@/lib/pipeline/steps";
import ReportView from "@/components/ReportView";

const STEP_LABEL: Record<StepName, string> = {
  fetch: "read site", render: "browser", technical: "seo", geo: "ai visibility", content: "content", marketing: "marketing", performance: "speed",
  social: "social", competitors: "competitors", synthesis: "report",
};

// What the audit is made of, shown the way RepoRecon shows its stack.
const STACK_TICKER = [
  "NVIDIA NIM", "Google Gemini", "PageSpeed Insights", "Headless Chromium", "Scrapling", "Agent-Reach",
  "Evidence-checked AI", "Per-visitor rate limits", "No logins, public pages only",
];

export default function Home() {
  const { state, run, reset } = useScanStream();
  const [url, setUrl] = useState("");
  const running = state.status === "running";

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (url.trim() && !running) run(url.trim());
  };

  const stepStatus = (step: StepName): "pending" | "running" | "done" =>
    state.doneSteps.includes(step) || state.status === "done" ? "done" : state.currentStep === step ? "running" : "pending";
  const limited = state.error ? /rate limit|busy/i.test(state.error) : false;

  return (
    <div className="min-h-screen bg-ground px-6 py-16">
      <main className="mx-auto w-full max-w-4xl">
        <div className="flex items-center gap-2 font-mono text-xs uppercase tracking-[0.2em] text-muted">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-live animate-pulse-dot" />
          website recon
        </div>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-ink sm:text-4xl">SiteRecon</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-soft">
          Paste a website address. SiteRecon reads the site and checks its search and AI-search readiness, content, speed, public social profiles and
          nearest competitors, then gives you a prioritised fix list and a prompt you can hand to Claude. Every finding quotes evidence from the page.
        </p>

        <div className="mt-6 overflow-hidden border-y border-line py-2" aria-hidden="true">
          <div className="flex w-max animate-marquee gap-8 whitespace-nowrap font-mono text-[11px] uppercase tracking-widest text-muted">
            {[...STACK_TICKER, ...STACK_TICKER].map((item, i) => (
              <span key={i} className="flex items-center gap-8">
                {item}
                <span className="text-line">·</span>
              </span>
            ))}
          </div>
        </div>

        <form onSubmit={onSubmit} className="mt-8 flex flex-col gap-3 sm:flex-row">
          <label htmlFor="url" className="sr-only">Website address</label>
          <input
            id="url" type="text" inputMode="url" autoComplete="url" required value={url} disabled={running}
            onChange={(e) => setUrl(e.target.value)} placeholder="yourbusiness.com"
            className="flex-1 rounded border border-line bg-surface px-3 py-2 font-mono text-sm text-ink placeholder:text-muted focus:border-accent focus:outline-none disabled:opacity-60"
          />
          <button
            type="submit" disabled={running || !url.trim()}
            className="rounded bg-accent px-5 py-2 text-sm font-medium text-ground transition-colors hover:bg-ink disabled:opacity-50"
          >
            {running ? "Scanning…" : "Run audit"}
          </button>
        </form>
        <p className="mt-3 font-mono text-xs text-muted">
          Free. Reads public pages only and respects robots.txt.{" "}
          <Link href="/sample" className="underline hover:text-accent">Sample report</Link> ·{" "}
          <Link href="/methodology" className="underline hover:text-accent">What is checked</Link> ·{" "}
          <Link href="/accuracy" className="underline hover:text-accent">How it is tested</Link>
        </p>

        {state.status !== "idle" && (
          <>
            <div className="mt-8 flex flex-wrap gap-2" aria-live="polite">
              {STEPS.map((step, i) => {
                const status = stepStatus(step);
                return (
                  <div
                    key={step}
                    className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 font-mono text-xs transition-colors ${
                      status === "done"
                        ? "border-live/50 bg-live/10 text-live"
                        : status === "running"
                          ? "border-accent bg-accent/10 text-accent"
                          : "border-line bg-surface text-muted"
                    }`}
                  >
                    {status === "running" && <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent animate-pulse-dot" />}
                    {status === "done" && <span className="text-live">✓</span>}
                    <span className="text-muted">{String(i + 1).padStart(2, "0")}</span>
                    {STEP_LABEL[step]}
                  </div>
                );
              })}
            </div>

            {state.trace.length > 0 && (
              <div className="mt-4 space-y-1 rounded border border-line bg-surface p-4 font-mono text-xs">
                {state.trace.map((t, i) => (
                  <div key={i} className={`animate-fade-up ${t.warn ? "text-muted" : "text-ink-soft"}`}>
                    <span className="font-semibold text-accent">[{STEP_LABEL[t.step]}]</span> {t.warn ? "could not run: " : ""}{t.message}
                  </div>
                ))}
              </div>
            )}

            {state.status === "error" && (
              <div className="mt-6 rounded border border-alert/40 bg-alert/10 px-4 py-3 text-sm text-alert">
                <p>{state.error}</p>
                <div className="mt-3 flex flex-wrap gap-3">
                  <button onClick={reset} className="rounded border border-line bg-surface px-3 py-1.5 text-ink transition-colors hover:border-accent hover:text-accent">Try again</button>
                  {limited && <Link href="/sample" className="rounded border border-line bg-surface px-3 py-1.5 text-ink transition-colors hover:border-accent hover:text-accent">See a sample report instead</Link>}
                </div>
              </div>
            )}

            {state.status === "done" && state.report && (
              <div className="mt-8 animate-fade-up">
                {state.cachedAt && (
                  <p className="mb-6 font-mono text-xs text-muted">
                    Showing the report from {new Date(state.cachedAt).toLocaleString()}. Sites are re-scanned at most once every 24 hours.
                  </p>
                )}
                <ReportView report={state.report} />
                <button
                  onClick={() => { reset(); setUrl(""); }}
                  className="mt-10 rounded border border-line bg-surface px-4 py-2 text-sm font-medium text-ink transition-colors hover:border-accent hover:text-accent"
                >
                  Scan another site
                </button>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
