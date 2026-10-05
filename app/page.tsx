"use client";
import { useState } from "react";
import { useScanStream } from "@/lib/useScanStream";
// Import from steps, not run: run pulls in server-only code and would break the client build.
import { STEPS, type StepName } from "@/lib/pipeline/steps";
import ReportView from "@/components/ReportView";

const STEP_LABEL: Record<StepName, string> = {
  fetch: "Read site", technical: "SEO", geo: "AI visibility", content: "Content", performance: "Speed", synthesis: "Report",
};

export default function Home() {
  const { state, run, reset } = useScanStream();
  const [url, setUrl] = useState("");
  const running = state.status === "running";

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (url.trim() && !running) run(url.trim());
  };

  return (
    <main className="mx-auto max-w-4xl px-4 py-16 sm:py-24">
      <p className="mb-3 text-xs uppercase tracking-widest text-[var(--muted)]">SiteRecon</p>
      <h1 className="max-w-[20ch] text-4xl font-semibold tracking-tight sm:text-5xl">How does your website perform?</h1>
      <p className="mt-4 max-w-[60ch] text-lg text-[var(--muted)]">
        Paste a website address. SiteRecon reads the site and checks its search and AI-search readiness, then gives you a prioritised fix list and a prompt you can hand to Claude.
      </p>

      <form onSubmit={onSubmit} className="mt-8 flex flex-col gap-3 sm:flex-row">
        <label htmlFor="url" className="sr-only">Website address</label>
        <input
          id="url" type="text" inputMode="url" autoComplete="url" required value={url} disabled={running}
          onChange={(e) => setUrl(e.target.value)} placeholder="example.com"
          className="flex-1 border border-[var(--line)] bg-[var(--ground)] px-4 py-3 text-base outline-none focus-visible:border-[var(--ink)] disabled:opacity-60"
        />
        <button type="submit" disabled={running || !url.trim()} className="border border-[var(--ink)] bg-[var(--ink)] px-6 py-3 text-[var(--ground)] disabled:opacity-50">
          {running ? "Scanning…" : "Scan site"}
        </button>
      </form>
      <p className="mt-3 text-sm text-[var(--muted)]">Free. Reads public pages only and respects robots.txt.</p>

      {state.status !== "idle" && (
        <div className="mt-10 border border-[var(--line)] p-6" aria-live="polite">
          <ol className="flex flex-wrap gap-x-5 gap-y-1 text-xs uppercase tracking-wide">
            {STEPS.map((step) => {
              const done = state.doneSteps.includes(step) || state.status === "done";
              const current = state.currentStep === step;
              return (
                <li key={step} style={{ color: done ? "var(--live)" : current ? "var(--ink)" : "var(--muted)" }}>
                  {done ? "✓" : current ? "›" : "·"} {STEP_LABEL[step]}
                </li>
              );
            })}
          </ol>

          {state.trace.length > 0 && (
            <ul className="mt-4 space-y-1 border-t border-[var(--line)] pt-4 text-sm">
              {state.trace.map((t, i) => (
                <li key={i} style={{ color: t.warn ? "var(--warn)" : "var(--muted)" }}>
                  [{STEP_LABEL[t.step]}] {t.warn ? "Could not run: " : ""}{t.message}
                </li>
              ))}
            </ul>
          )}

          {state.status === "error" && (
            <div className="mt-4">
              <p>{state.error}</p>
              <button onClick={reset} className="mt-3 border border-[var(--line)] px-4 py-2 text-sm">Try again</button>
            </div>
          )}

          {state.status === "done" && state.report && (
            <div className="mt-6 border-t border-[var(--line)] pt-6">
              {state.cachedAt && (
                <p className="mb-4 text-sm text-[var(--muted)]">
                  Showing the report from {new Date(state.cachedAt).toLocaleString()}. Sites are re-scanned at most once every 24 hours.
                </p>
              )}
              <ReportView report={state.report} />
              <button onClick={() => { reset(); setUrl(""); }} className="mt-8 border border-[var(--line)] px-4 py-2 text-sm">Scan another site</button>
            </div>
          )}
        </div>
      )}
    </main>
  );
}
