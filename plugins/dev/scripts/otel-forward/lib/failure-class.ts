// CTL-2084: classify an exhausted-retry forward failure into a bounded category so the
// cause survives OFF-MACHINE as a queryable attribute on `catalyst.observability.forward_failed`.
// The `err` diagnostic previously lived only in `body.payload`, which `buildOtlpPayload` strips
// before OTLP export (otlp.ts) — so Loki saw nothing but host/severity. Mirrors `emitDrop`'s
// `drop_reason` attribute promotion.
import { HttpError } from "./retry.ts";

export type ForwardFailureCategory =
  | "http_429" // backpressure / rate-limit
  | "http_5xx" // collector/server error
  | "timeout" // per-request AbortSignal.timeout fired
  | "aborted" // shutdown abort (daemon stop)
  | "connection_refused"
  | "dns"
  | "network" // generic fetch failed / connectivity
  | "other";

export interface ForwardFailure {
  category: ForwardFailureCategory;
  httpStatus?: number;
}

// Only *retryable* causes reach forward_failed (terminal 4xx routes to forward_dropped),
// so auth/payload categories are intentionally unrepresentable here.
export function classifyForwardFailure(err: unknown): ForwardFailure {
  if (err instanceof HttpError) {
    // classifyStatus guarantees only retryable statuses arrive; still branch defensively.
    if (err.status === 429) return { category: "http_429", httpStatus: err.status };
    if (err.status >= 500) return { category: "http_5xx", httpStatus: err.status };
    return { category: "other", httpStatus: err.status };
  }
  const name = err instanceof Error ? err.name : "";
  const msg = err instanceof Error ? err.message : String(err ?? "");
  // node fetch wraps the low-level error in `.cause`; inspect its code first.
  const code =
    (err as { cause?: { code?: unknown } } | undefined)?.cause?.code ??
    (err as { code?: unknown } | undefined)?.code;
  const codeStr = typeof code === "string" ? code : "";

  // ⛔ Check the CODE before the message. A connect/socket timeout arrives as
  // `ETIMEDOUT` (or undici's `UND_ERR_CONNECT_TIMEOUT`), and neither string matches
  // /timed out|timeout/ — "ETIMEDOUT" does not contain "timeout". Without this branch a
  // plain socket timeout fell through every rule to `other`, which is the
  // could-not-classify bucket, in a classifier whose whole purpose is grouping. A
  // connect timeout is one of the commonest OTLP forwarding failures, so `other` would
  // have been a large and permanently unexplained slice of the per-category breakdown.
  if (codeStr === "ETIMEDOUT" || codeStr === "UND_ERR_CONNECT_TIMEOUT" || /ETIMEDOUT/.test(msg))
    return { category: "timeout" };
  if (name === "TimeoutError" || /timed out|timeout/i.test(msg)) return { category: "timeout" };
  if (name === "AbortError") return { category: "aborted" };
  if (codeStr === "ECONNREFUSED" || /ECONNREFUSED/.test(msg))
    return { category: "connection_refused" };
  if (
    codeStr === "ENOTFOUND" ||
    codeStr === "EAI_AGAIN" ||
    /ENOTFOUND|EAI_AGAIN|getaddrinfo/.test(msg)
  )
    return { category: "dns" };
  if (/fetch failed|ECONNRESET|EPIPE|network/i.test(msg)) return { category: "network" };
  return { category: "other" };
}
