// config.mjs — catalyst-agent configuration: logger, path resolvers, and the
// per-call env reader for emit mode / OTLP target / cadence / domain toggles.
// Zero internal deps (leaf module) and zero npm deps — node:* builtins only, so
// the file runs unchanged under both node>=18 and bun. Mirrors
// execution-core/config.mjs (CTL-578 pino-with-console-shim, CTL-787 per-call
// env readers) but is SELF-CONTAINED: the standalone agent never imports from
// execution-core.
//
// CTL-812: the catalyst-agent is a host-level telemetry daemon launched by
// launchd (StartInterval). Path resolvers re-read CATALYST_DIR per call so tests
// redirect by setting the env var; the launchd process pins a stable value.

import { homedir } from "node:os";
import { resolve } from "node:path";

// --- Logger (mirrors execution-core CTL-578) ---
// Pino is the daemon's runtime logger. The standalone agent ships with no
// node_modules, so `pino` is virtually always unresolvable here — wrap the
// import in try/catch and substitute a console-shim with the same
// pino-compatible surface so the agent degrades gracefully instead of aborting
// at module-load.
let log;
try {
  const { default: pino } = await import("pino");
  log = pino({
    name: "catalyst-agent",
    level: process.env.LOG_LEVEL ?? "info",
  });
} catch (err) {
  const emit = (level) => (...args) => {
    // pino-style: log.info(obj, msg) OR log.info(msg). Console-shim flattens.
    const stream =
      level === "error" || level === "fatal" ? process.stderr : process.stdout;
    stream.write(
      `[catalyst-agent:${level}] ${args
        .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
        .join(" ")}\n`,
    );
  };
  log = {
    info: emit("info"),
    warn: emit("warn"),
    error: emit("error"),
    debug: emit("debug"),
    fatal: emit("fatal"),
    trace: emit("trace"),
    child: () => log,
  };
  process.stderr.write(
    `[catalyst-agent] WARN: pino unavailable (${err?.message ?? err}); using console shim\n`,
  );
}
export { log };

// --- Paths ---
// Re-resolved per call so tests can redirect by setting CATALYST_DIR;
// production launches pin a stable value.
function catalystDir() {
  return process.env.CATALYST_DIR ?? `${homedir()}/catalyst`;
}

// The unified monthly event log (Approach A emit target). UTC month to match
// the writer convention shared with execution-core/orch-monitor — the tailer
// resolves the same path or it would follow the wrong file. Own copy: the
// standalone agent does not import execution-core's getEventLogPath.
export function getEventLogPath() {
  const now = new Date();
  const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  return resolve(catalystDir(), "events", `${ym}.jsonl`);
}

// --- Cadence floor ---
// The launchd StartInterval and --loop cadence are both driven by intervalMs.
// 3 min is the hard floor (matches the rate-limit poller floor) so a misset env
// can never hammer the usage endpoint into a persistent 429.
const INTERVAL_FLOOR_MS = 180000;
const INTERVAL_DEFAULT_MS = 300000;

// --- Agent config (CTL-812) ---
// Re-reads from process.env on every call so tests can manipulate env vars
// freely (mirrors execution-core's readMemorySamplerConfig / readRatelimitPollerConfig).
//
// Knobs:
//   CATALYST_AGENT_EMIT            eventlog | otlp | both   (default eventlog)
//   CATALYST_AGENT_OTLP_ENDPOINT   base URL; /v1/logs is appended on POST
//   CATALYST_AGENT_OTLP_HEADERS    "k=v,k=v" extra headers for the OTLP POST
//   CATALYST_AGENT_INTERVAL_MS     tick cadence (default 300000, floor 180000)
//   CATALYST_AGENT_TOP_N           top-N processes by RSS (default 10, floor 1)
//   CATALYST_AGENT_USAGE           account rate-limit domain on/off (default on)
//   CATALYST_AGENT_HOST            host.metrics domain on/off (default on)
//   CATALYST_AGENT_PROCESS         host.process domain on/off (default on)
export function readAgentConfig() {
  const emit = normalizeEmitMode(process.env.CATALYST_AGENT_EMIT);

  const rawInterval = Number(process.env.CATALYST_AGENT_INTERVAL_MS);
  const intervalMs = Math.max(
    INTERVAL_FLOOR_MS,
    Number.isFinite(rawInterval) && rawInterval > 0 ? rawInterval : INTERVAL_DEFAULT_MS,
  );

  const rawTopN = Number(process.env.CATALYST_AGENT_TOP_N);
  const topN = Math.max(1, Number.isFinite(rawTopN) && rawTopN > 0 ? Math.floor(rawTopN) : 10);

  return {
    emit,
    otlpEndpoint: process.env.CATALYST_AGENT_OTLP_ENDPOINT || null,
    otlpHeaders: parseHeaders(process.env.CATALYST_AGENT_OTLP_HEADERS),
    // CTL-1227: metrics have NO eventlog path — they only flow via OTLP /v1/metrics.
    // So metric emission is decoupled from the event `emit` mode: post whenever a
    // metrics endpoint is resolvable. Dedicated CATALYST_AGENT_METRICS_ENDPOINT,
    // falling back to the shared OTLP endpoint. (Events keep shipping via the
    // catalyst-otel-forward → /v1/logs path in eventlog mode.)
    metricsEndpoint:
      process.env.CATALYST_AGENT_METRICS_ENDPOINT || process.env.CATALYST_AGENT_OTLP_ENDPOINT || null,
    intervalMs,
    topN,
    // Per-domain toggles default ON; "0" is the explicit opt-out (mirrors the
    // execution-core CATALYST_* kill-switch convention).
    usageEnabled: process.env.CATALYST_AGENT_USAGE !== "0",
    hostEnabled: process.env.CATALYST_AGENT_HOST !== "0",
    processEnabled: process.env.CATALYST_AGENT_PROCESS !== "0",
  };
}

// normalizeEmitMode — clamp the emit knob to one of the three valid modes.
// Anything unrecognized (including unset) falls back to "eventlog" so a typo
// never silently drops telemetry to nowhere.
function normalizeEmitMode(raw) {
  const v = String(raw ?? "").toLowerCase();
  return v === "otlp" || v === "both" ? v : "eventlog";
}

// parseHeaders — split a "k=v,k=v" list into an object. Empty/missing → {}.
// Tolerant of stray whitespace; a pair without "=" is skipped. Values may
// themselves contain "=" (only the first is the separator), e.g. base64 tokens.
function parseHeaders(raw) {
  const out = {};
  if (!raw) return out;
  for (const pair of String(raw).split(",")) {
    const idx = pair.indexOf("=");
    if (idx === -1) continue;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}
