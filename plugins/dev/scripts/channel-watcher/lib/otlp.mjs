// otlp.mjs — CTL-1423. OTLP HTTP transport for the channel-watcher.
// Mirrors catalyst-agent/emit.mjs sendOtlp / emitEnvelope patterns exactly:
// best-effort (never throws), returns true/false, and routes by cfg.emit.

import { appendEnvelope } from "./emit.mjs";

function otlpAnyValue(v) {
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "number") return { doubleValue: v };
  if (typeof v === "boolean") return { boolValue: v };
  return { stringValue: String(v) };
}

function otlpAttributes(obj) {
  return Object.entries(obj).map(([key, value]) => ({ key, value: otlpAnyValue(value) }));
}

function envelopeToLogRecord(envelope) {
  const ms = Date.parse(envelope.ts);
  const timeUnixNano = String((Number.isFinite(ms) ? ms : Date.now()) * 1_000_000);
  return {
    timeUnixNano,
    observedTimeUnixNano: timeUnixNano,
    severityNumber: 9,
    severityText: "INFO",
    body: { stringValue: envelope.attributes?.["event.name"] ?? "" },
    attributes: otlpAttributes(envelope.attributes ?? {}),
  };
}

/**
 * sendWatcherOtlp — POST one envelope to <endpoint>/v1/logs as OTLP/HTTP JSON.
 * Best-effort: resolves to true on 2xx, false otherwise; NEVER throws.
 * @param {object} envelope
 * @param {object} opts
 * @param {string} opts.endpoint
 * @param {object} [opts.headers]
 * @param {Function} [opts.fetchImpl]
 * @returns {Promise<boolean>}
 */
export async function sendWatcherOtlp(envelope, { endpoint, headers = {}, fetchImpl = fetch } = {}) {
  if (!endpoint || !envelope) return false;
  const url = `${endpoint.replace(/\/+$/, "")}/v1/logs`;
  const resourceAttrs = otlpAttributes(envelope.resource ?? {});
  const body = {
    resourceLogs: [
      {
        resource: { attributes: resourceAttrs },
        scopeLogs: [
          {
            scope: { name: "catalyst-channel-watcher" },
            logRecords: [envelopeToLogRecord(envelope)],
          },
        ],
      },
    ],
  };
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    return res?.status >= 200 && res?.status < 300;
  } catch {
    return false;
  }
}

/**
 * emitWatcherEnvelope — route one envelope through the configured transport(s).
 * emit: "eventlog" → write to logPath only
 * emit: "otlp"     → POST to otlpEndpoint only
 * emit: "both"     → both
 * Returns the OTLP POST promise (or null when no POST issued) so callers can await it.
 *
 * @param {object} envelope
 * @param {object} cfg
 * @param {string} [cfg.emit]          "eventlog"|"otlp"|"both" (default: "eventlog")
 * @param {string} [cfg.logPath]
 * @param {string} [cfg.otlpEndpoint]
 * @param {object} [cfg.otlpHeaders]
 * @param {Function} [cfg.fetchImpl]
 * @returns {Promise<boolean>|null}
 */
export async function emitWatcherEnvelope(envelope, cfg = {}) {
  const mode = cfg.emit ?? "eventlog";
  if (mode === "eventlog" || mode === "both") {
    await appendEnvelope(cfg.logPath, envelope).catch(() => {});
  }
  if (mode === "otlp" || mode === "both") {
    return sendWatcherOtlp(envelope, {
      endpoint: cfg.otlpEndpoint,
      headers: cfg.otlpHeaders,
      fetchImpl: cfg.fetchImpl,
    }).catch(() => false);
  }
  return null;
}
