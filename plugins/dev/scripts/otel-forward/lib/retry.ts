export async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts: number,
  delaysMs: number[]
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < maxAttempts; i++) {
    try { return await fn(); } catch (err) {
      lastErr = err;
      if (i < delaysMs.length) await new Promise((r) => setTimeout(r, delaysMs[i]));
    }
  }
  throw lastErr;
}

export const DEFAULT_RETRY_DELAYS_MS = [0, 1000, 5000] as const;

// CTL-1506: HTTP-status-aware retry — terminal 4xx aborts immediately, 5xx/429/network errors
// use exponential backoff over a time window (materially longer than the old 6 s mechanical retry).

export class HttpError extends Error {
  constructor(public readonly status: number, public readonly retryAfterMs?: number) {
    super(`OTLP HTTP ${status}`);
    this.name = "HttpError";
  }
}

export type FailureClass = "retryable" | "terminal";

export function classifyStatus(status: number): FailureClass {
  if (status === 429) return "retryable";
  if (status >= 500) return "retryable";
  return "terminal";
}

export function parseRetryAfter(header: string | null, nowMs: number): number | undefined {
  if (!header) return undefined;
  const secs = Number(header.trim());
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(header);
  if (Number.isNaN(when)) return undefined;
  return Math.max(0, when - nowMs);
}

export interface HttpRetryPolicy {
  baseMs?: number;
  factor?: number;
  maxDelayMs?: number;
  maxElapsedMs?: number;
}

export const DEFAULT_HTTP_RETRY_POLICY: Required<HttpRetryPolicy> = {
  baseMs: 500, factor: 2, maxDelayMs: 30_000, maxElapsedMs: 60_000,
};

export interface HttpRetryClock {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** CTL-1506 (Codex P1): abort the retry loop early (e.g. on daemon shutdown) so a
   *  long backoff can't outlive the launcher's SIGKILL grace — the caller then DLQs. */
  signal?: AbortSignal;
}

export async function withHttpRetry<T>(
  fn: () => Promise<T>,
  policy: HttpRetryPolicy = {},
  clock: HttpRetryClock = {}
): Promise<T> {
  const p = { ...DEFAULT_HTTP_RETRY_POLICY, ...policy };
  const now = clock.now ?? (() => Date.now());
  // CTL-1506 (Codex P1): the default backoff sleep is abortable — on shutdown the pending
  // sleep resolves immediately (instead of blocking for a 4/8/16/30s backoff), so the
  // post-sleep abort check fires right away and the caller DLQs within the launcher grace.
  // CTL-1506 (Codex P2): the abort listener is removed on BOTH the timer firing and the
  // abort — else every completed retry backoff would leak a settled-closure listener on
  // the long-lived daemon-wide signal (listener warnings + unbounded memory over time).
  const sleep = clock.sleep ?? ((ms) => new Promise<void>((r) => {
    const sig = clock.signal;
    if (sig?.aborted) return r();
    let onAbort: (() => void) | undefined;
    const t = setTimeout(() => {
      if (sig && onAbort) sig.removeEventListener("abort", onAbort);
      r();
    }, ms);
    if (sig) {
      onAbort = () => { clearTimeout(t); r(); };
      sig.addEventListener("abort", onAbort, { once: true });
    }
  }));
  const start = now();
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      const isTerminal = err instanceof HttpError && classifyStatus(err.status) === "terminal";
      if (isTerminal) throw err;
      if (clock.signal?.aborted) throw err; // CTL-1506 (Codex P1): shutdown → stop, caller DLQs
      const elapsed = now() - start;
      if (elapsed >= p.maxElapsedMs) throw err;
      const backoff = Math.min(p.baseMs * p.factor ** attempt, p.maxDelayMs);
      const retryAfter = err instanceof HttpError ? err.retryAfterMs : undefined;
      const wanted = Math.max(backoff, retryAfter ?? 0);
      // CTL-1506 (Codex P2): if the required wait would land us at/after the deadline,
      // stop now rather than sleeping-then-firing a doomed extra attempt. The old code
      // capped the delay to the remaining window and always retried once more, which
      // burned another request timeout past maxElapsedMs and — when a server sent a
      // Retry-After longer than the remaining window — sent before it asked us to.
      if (elapsed + wanted >= p.maxElapsedMs) throw err;
      attempt++;
      await sleep(wanted);
      // CTL-1506 (Codex P2): recheck the ACTUAL deadline after sleeping — a delayed event
      // loop or a suspended host can make sleep() resolve past maxElapsedMs, and we must
      // not start another request (and its timeout) beyond the window. Also re-honor abort.
      if (clock.signal?.aborted) throw err;
      if (now() - start >= p.maxElapsedMs) throw err;
    }
  }
}
