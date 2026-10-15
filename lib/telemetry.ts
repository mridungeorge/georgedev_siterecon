import { z } from "zod";

// Scan telemetry: how long each step took, how it ended, and which outside providers were used.
// Every provider here runs on a free tier, so the cost of a report is zero by construction; what is
// worth watching is how much of each provider's daily cap a scan uses, which `steps` shows.

export const TelemetrySchema = z.object({
  steps: z.array(z.object({ step: z.string(), ms: z.number().int().min(0), outcome: z.enum(["done", "warned"]) })),
  totalMs: z.number().int().min(0),
  providers: z.array(z.object({ provider: z.enum(["llm", "pagespeed", "fetchService"]), steps: z.array(z.string()) })),
  estimatedCostUsd: z.number().min(0),
  /** How many requests this scan made to each outside provider, and how many site pages it fetched. */
  calls: z.record(z.string(), z.number().int().min(0)).default({}),
});
export type Telemetry = z.infer<typeof TelemetrySchema>;

type Provider = "llm" | "pagespeed" | "fetchService";
/** Which pipeline steps call which outside service. */
const PROVIDER_STEPS: Record<Provider, string[]> = {
  llm: ["citation", "content", "marketing", "competitors", "synthesis"],
  pagespeed: ["performance"],
  fetchService: ["render", "social"],
};

export function createTelemetryRecorder(now: () => number = Date.now) {
  const started = new Map<string, number>();
  const steps: Telemetry["steps"] = [];

  const end = (step: string, outcome: "done" | "warned") => {
    const at = started.get(step);
    if (at === undefined) return;
    started.delete(step);
    steps.push({ step, ms: Math.max(0, Math.round(now() - at)), outcome });
  };

  return {
    start(step: string) {
      started.set(step, now());
    },
    done: (step: string) => end(step, "done"),
    warn: (step: string) => end(step, "warned"),
    finish(available: Record<Provider, boolean>, calls: Record<string, number> = {}): Telemetry {
      const completed = new Set(steps.filter((s) => s.outcome === "done").map((s) => s.step));
      return {
        steps,
        totalMs: steps.reduce((sum, s) => sum + s.ms, 0),
        providers: (Object.keys(PROVIDER_STEPS) as Provider[]).map((provider) => ({
          provider,
          steps: available[provider] ? PROVIDER_STEPS[provider].filter((s) => completed.has(s)) : [],
        })),
        estimatedCostUsd: 0,
        calls: { ...calls },
      };
    },
  };
}
