"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Report } from "@/lib/pipeline/schemas";
import type { StepName } from "@/lib/pipeline/steps";

export interface ScanState {
  status: "idle" | "running" | "error" | "done";
  currentStep: StepName | null;
  doneSteps: StepName[];
  trace: { step: StepName; message: string; warn: boolean }[];
  report: Report | null;
  cachedAt: string | null;
  error: string | null;
}

const initial: ScanState = { status: "idle", currentStep: null, doneSteps: [], trace: [], report: null, cachedAt: null, error: null };

/**
 * Reads the scan stream with fetch and a small SSE parser, as the portfolio's
 * useAuditStream does for RepoRecon. EventSource cannot read the JSON body of a 400,
 * 429 or 503 reply, and those messages are what the visitor needs to see.
 */
export function useScanStream(base = "") {
  const [state, setState] = useState<ScanState>(initial);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setState(initial);
  }, []);

  const run = useCallback(async (url: string) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setState({ ...initial, status: "running" });

    try {
      const res = await fetch(`${base}/api/scan/stream?url=${encodeURIComponent(url)}`, { signal: controller.signal });
      if (!res.ok || !res.body) {
        let message = `SiteRecon returned an error (HTTP ${res.status}).`;
        try {
          const body = await res.json();
          if (body?.error) message = body.error;
        } catch {
          // not JSON: keep the generic message
        }
        setState((s) => ({ ...s, status: "error", error: message }));
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finished = false;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          const event = /^event: (.+)$/m.exec(block)?.[1];
          const raw = /^data: (.+)$/m.exec(block)?.[1];
          if (!event || !raw) continue; // heartbeat comments land here
          const data = JSON.parse(raw);
          if (event === "step-start") {
            setState((s) => ({ ...s, currentStep: data.step }));
          } else if (event === "step-done" || event === "step-warn") {
            setState((s) => ({
              ...s,
              currentStep: null,
              doneSteps: [...s.doneSteps, data.step],
              trace: [...s.trace, { step: data.step, message: data.message ?? "", warn: event === "step-warn" }],
            }));
          } else if (event === "cached") {
            setState((s) => ({ ...s, cachedAt: data.createdAt }));
          } else if (event === "report") {
            finished = true;
            setState((s) => ({ ...s, status: "done", report: data, currentStep: null }));
          } else if (event === "error") {
            finished = true;
            setState((s) => ({ ...s, status: "error", error: data.message ?? "The scan failed.", currentStep: null }));
          }
        }
      }
      if (!finished) setState((s) => ({ ...s, status: "error", error: "The connection closed before the scan finished." }));
    } catch (err) {
      if (controller.signal.aborted) return; // cancelled by reset() or a new run
      setState((s) => ({ ...s, status: "error", error: err instanceof Error ? err.message : "Could not reach SiteRecon." }));
    }
  }, [base]);

  return { state, run, reset };
}
