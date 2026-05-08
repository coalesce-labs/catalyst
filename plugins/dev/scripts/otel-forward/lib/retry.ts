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
