// Retry with exponential backoff for the outside services (PageSpeed, the AI providers, search).
// Only failures that are worth repeating are retried: a busy or rate-limited service, or a network
// blip. A bad key or a refused request is not. Waits are capped, a Retry-After header is honoured,
// and a cancelled scan stops at once, so retrying can never make a scan outlast its budget.

export class TransientError extends Error {
  constructor(message: string, readonly status?: number, readonly retryAfterMs?: number) {
    super(message);
  }
}

export const isTransientStatus = (status: number): boolean => status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);

export interface BackoffOptions {
  /** Extra attempts after the first. Default 2. */
  retries?: number;
  baseMs?: number;
  factor?: number;
  maxMs?: number;
  signal?: AbortSignal;
  /** A multiplier from 0 to 1 applied to each wait, so many clients do not retry in step. Injected in tests. */
  jitter?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("The scan was cancelled."));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("The scan was cancelled.")); }, { once: true });
  });

const isNetworkBlip = (err: unknown): boolean =>
  err instanceof TypeError && /fetch failed|network|ECONNRESET|ENOTFOUND|socket/i.test(err.message);

export async function withBackoff<T>(fn: (attempt: number) => Promise<T>, opts: BackoffOptions = {}): Promise<T> {
  const { retries = 2, baseMs = 400, factor = 2, maxMs = 4_000, signal } = opts;
  const jitter = opts.jitter ?? (() => 0.5 + Math.random() / 2);
  const sleep = opts.sleep ?? defaultSleep;

  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (signal?.aborted) throw err;
      const transient = err instanceof TransientError || isNetworkBlip(err);
      if (!transient || attempt >= retries) throw err;
      const exponential = Math.min(maxMs, baseMs * factor ** attempt);
      const asked = err instanceof TransientError ? err.retryAfterMs : undefined;
      const wait = asked !== undefined ? Math.min(maxMs, asked) : Math.round(exponential * jitter());
      await sleep(wait, signal);
    }
  }
}

export interface FetchJsonOptions extends BackoffOptions {
  fetch?: typeof fetch;
  init?: RequestInit;
  /** Time allowed for each attempt. */
  timeoutMs?: number;
}

/** GET or POST a JSON endpoint, retrying 408, 425, 429 and 5xx answers and network blips. */
export async function fetchJsonWithBackoff(url: string, opts: FetchJsonOptions = {}): Promise<unknown> {
  const doFetch = opts.fetch ?? fetch;
  return withBackoff(async () => {
    const timeout = opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined;
    const signals = [timeout, opts.signal].filter((s): s is AbortSignal => s !== undefined);
    const signal = signals.length === 0 ? undefined : signals.length === 1 ? signals[0] : AbortSignal.any(signals);
    const res = await doFetch(url, { ...opts.init, ...(signal ? { signal } : {}) });
    if (!res.ok) {
      if (isTransientStatus(res.status)) {
        const header = Number(res.headers.get("retry-after"));
        throw new TransientError(`HTTP ${res.status}`, res.status, Number.isFinite(header) && header > 0 ? header * 1000 : undefined);
      }
      throw new Error(`HTTP ${res.status}`);
    }
    return res.json();
  }, opts);
}
