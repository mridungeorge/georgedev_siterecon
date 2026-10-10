import type { Report } from "@/lib/pipeline/schemas";

// Logs one MLflow run per finished scan to a self-hosted MLflow (docs/DEPLOY.md says how to run one), in
// its own experiment ("siterecon"). Every failure is swallowed: logging must never affect a scan.

const EXPERIMENT = "siterecon";
const experimentIds = new Map<string, string>();

export function resetMlflowCache(): void {
  experimentIds.clear();
}

export interface MlflowOptions {
  baseUrl: string;
  fetch?: typeof fetch;
}

export async function logScanRun(opts: MlflowOptions, report: Report, durationMs: number): Promise<boolean> {
  const doFetch = opts.fetch ?? fetch;
  const base = opts.baseUrl.replace(/\/+$/, "") + "/api/2.0/mlflow";

  const call = async (path: string, init?: RequestInit): Promise<Response> => {
    const res = await doFetch(`${base}/${path}`, { ...init, headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(8_000) });
    if (!res.ok && !(res.status === 404 && path.startsWith("experiments/get-by-name"))) throw new Error(`MLflow ${path} returned HTTP ${res.status}`);
    return res;
  };
  const post = (path: string, body: unknown) => call(path, { method: "POST", body: JSON.stringify(body) });

  try {
    let experimentId = experimentIds.get(base);
    if (!experimentId) {
      const found = await call(`experiments/get-by-name?experiment_name=${EXPERIMENT}`);
      if (found.ok) experimentId = String(((await found.json()) as { experiment: { experiment_id: string } }).experiment.experiment_id);
      else experimentId = String(((await (await post("experiments/create", { name: EXPERIMENT })).json()) as { experiment_id: string }).experiment_id);
      experimentIds.set(base, experimentId);
    }

    const started = Date.now() - durationMs;
    const created = (await (await post("runs/create", { experiment_id: experimentId, start_time: started })).json()) as { run: { info: { run_id: string } } };
    const runId = created.run.info.run_id;

    const now = Date.now();
    const metrics: Record<string, number> = {
      duration_ms: durationMs,
      injection_flags: report.injectionFlags,
      couldnt_check: report.couldntCheck.length,
      pages_scanned: report.pagesScanned.length,
      findings: report.modules.reduce((n, m) => n + m.findings.length, 0),
      ideas: report.ideas.length,
    };
    if (report.overallScore !== null) metrics.overall_score = report.overallScore;
    for (const m of report.modules) if (m.score !== null) metrics[`score_${m.module}`] = m.score;

    await post("runs/log-batch", {
      run_id: runId,
      metrics: Object.entries(metrics).map(([key, value]) => ({ key, value, timestamp: now, step: 0 })),
      params: [{ key: "domain", value: report.domain }],
    });
    await post("runs/update", { run_id: runId, status: "FINISHED", end_time: now });
    return true;
  } catch {
    return false;
  }
}
