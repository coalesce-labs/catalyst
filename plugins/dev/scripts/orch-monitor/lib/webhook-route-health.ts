// webhook-route-health.ts — CTL-1841. Route-comparison detector for a 401-only
// Linear webhook delivery window.
//
// PURE (Phase 1 exports have no I/O except an injected marker-IO seam in Phase 2).
// ALERT-ONLY: a rotated HMAC secret is fixed by an operator, not a restart.
//
// The raise condition depends on NO Linear event volume — only last-2xx / last-fail /
// last-github-2xx timestamps. This sidesteps the bot-skip-guard volume problem entirely
// (the RECENCY_SOURCES catalyst.linear exclusion is correct and NOT reverted here).

import { mkdirSync, writeFileSync, renameSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hostname, homedir } from "node:os";
import { createSparseWarnGate } from "../../otel-forward/lib/sparse-warn";

// ─── State shape ─────────────────────────────────────────────────────────────

export interface WebhookRouteHealthState {
  /** Last 2xx from /api/webhook/linear (including the bot-skip guard's 200). */
  lastLinear2xxMs: number | null;
  /** Last non-2xx (4xx OR 5xx) from /api/webhook/linear. */
  lastLinearFailMs: number | null;
  /** Last 2xx from /api/webhook (the live GitHub control). */
  lastGithub2xxMs: number | null;
}

export function initialRouteHealthState(): WebhookRouteHealthState {
  return {
    lastLinear2xxMs: null,
    lastLinearFailMs: null,
    lastGithub2xxMs: null,
  };
}

// ─── Config ──────────────────────────────────────────────────────────────────

export interface WebhookRouteHealthConfig {
  /** CATALYST_LINEAR_WEBHOOK_ALARM !== "0" (default ON). */
  enabled: boolean;
  /** No Linear 2xx for this long → "silent" (default 15m). */
  silentThresholdMs: number;
  /** A Linear non-2xx seen within this window → "recent failure" (default 30m). */
  failRecencyWindowMs: number;
  /** A GitHub 2xx seen within this window → "control is live" (default 30m). */
  githubHealthyWindowMs: number;
  /** Evaluation interval (default 60s). */
  tickMs: number;
}

const MIN = 60_000;
const DEFAULTS = Object.freeze({
  silentThresholdMs: 15 * MIN,
  failRecencyWindowMs: 30 * MIN,
  githubHealthyWindowMs: 30 * MIN,
  tickMs: MIN,
});

export function resolveWebhookRouteHealthConfig(
  fileCfg: Partial<WebhookRouteHealthConfig> = {},
): WebhookRouteHealthConfig {
  const num = (env: string, fallback: number) => {
    const v = Number(process.env[env]);
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  return {
    enabled: process.env.CATALYST_LINEAR_WEBHOOK_ALARM !== "0",
    silentThresholdMs:
      fileCfg.silentThresholdMs ??
      num(
        "CATALYST_LINEAR_WEBHOOK_ALARM_SILENT_MS",
        DEFAULTS.silentThresholdMs,
      ),
    failRecencyWindowMs:
      fileCfg.failRecencyWindowMs ??
      num(
        "CATALYST_LINEAR_WEBHOOK_ALARM_FAIL_RECENCY_MS",
        DEFAULTS.failRecencyWindowMs,
      ),
    githubHealthyWindowMs:
      fileCfg.githubHealthyWindowMs ??
      num(
        "CATALYST_LINEAR_WEBHOOK_ALARM_GITHUB_WINDOW_MS",
        DEFAULTS.githubHealthyWindowMs,
      ),
    tickMs:
      fileCfg.tickMs ??
      num("CATALYST_LINEAR_WEBHOOK_ALARM_TICK_MS", DEFAULTS.tickMs),
  };
}

// ─── Pure classifier ─────────────────────────────────────────────────────────

export interface RouteHealthVerdict {
  raise: boolean;
  clear: boolean;
  route: "/api/webhook/linear";
  linearFailAgeMs: number | null;
  linearOkAgeMs: number | null;
  githubOkAgeMs: number | null;
}

/**
 * Classify the current route-health state.
 *
 * RAISE when ALL of:
 *   - the last Linear outcome was a failure (never succeeded, or fail is more recent than ok)
 *   - the GitHub control 2xx'd within githubHealthyWindowMs (proves tunnel/server are up)
 *   - the Linear failure is within failRecencyWindowMs (still relevant)
 *   - no Linear 2xx has been seen for silentThresholdMs or more (or ever)
 *
 * CLEAR when the last Linear outcome was a 2xx.
 */
export function classifyLinearWebhookHealth(
  s: WebhookRouteHealthState,
  nowMs: number,
  cfg: WebhookRouteHealthConfig,
): RouteHealthVerdict {
  const linearFailAgeMs =
    s.lastLinearFailMs === null ? null : nowMs - s.lastLinearFailMs;
  const linearOkAgeMs =
    s.lastLinear2xxMs === null ? null : nowMs - s.lastLinear2xxMs;
  const githubOkAgeMs =
    s.lastGithub2xxMs === null ? null : nowMs - s.lastGithub2xxMs;
  const base = {
    route: "/api/webhook/linear" as const,
    linearFailAgeMs,
    linearOkAgeMs,
    githubOkAgeMs,
  };

  // The last Linear outcome was a failure: never succeeded OR fail is more recent than ok.
  const lastOutcomeIsFail =
    s.lastLinearFailMs !== null &&
    (s.lastLinear2xxMs === null || s.lastLinear2xxMs < s.lastLinearFailMs);

  const raise =
    lastOutcomeIsFail &&
    githubOkAgeMs !== null &&
    githubOkAgeMs <= cfg.githubHealthyWindowMs && // control is live
    linearFailAgeMs !== null &&
    linearFailAgeMs <= cfg.failRecencyWindowMs && // fail is recent
    (linearOkAgeMs === null || linearOkAgeMs >= cfg.silentThresholdMs); // silent long enough

  // Recovery: a Linear 2xx is the most recent outcome.
  const clear =
    s.lastLinear2xxMs !== null &&
    (s.lastLinearFailMs === null || s.lastLinear2xxMs >= s.lastLinearFailMs);

  return { ...base, raise, clear };
}

// ─── Edge-state machine ───────────────────────────────────────────────────────

/**
 * EMIT-THEN-ADVANCE: fire on the rising/falling edge and advance the latch.
 * Mirrors nextBrokerDegradedLatch from broker-degraded.mjs.
 */
export function nextLinearWebhook401Latch(
  prev: boolean,
  { raise, clear }: { raise: boolean; clear: boolean },
): { latched: boolean; emit: "raised" | "recovered" | null } {
  if (!prev && raise) return { latched: true, emit: "raised" };
  if (prev && clear) return { latched: false, emit: "recovered" };
  return { latched: prev, emit: null };
}

// ─── Marker builder ───────────────────────────────────────────────────────────

export function buildRouteHealthMarker(args: {
  latched: boolean;
  latchedAtMs: number | null;
  state: WebhookRouteHealthState;
  nowMs: number;
  host?: string;
}): Record<string, unknown> {
  return {
    latched: args.latched,
    latchedAtMs: args.latchedAtMs,
    lastLinear2xxMs: args.state.lastLinear2xxMs,
    lastLinearFailMs: args.state.lastLinearFailMs,
    lastGithub2xxMs: args.state.lastGithub2xxMs,
    host: args.host ?? null,
    ts: new Date(args.nowMs).toISOString(),
  };
}

// ─── Marker path ──────────────────────────────────────────────────────────────

export function getLinearWebhook401MarkerPath(): string {
  const dir =
    process.env.CATALYST_DIR ?? join(homedir(), "catalyst");
  return join(dir, "linear-webhook-401-latch.json");
}

// ─── Stateful monitor (Phase 2 — server.ts uses this) ────────────────────────

export interface RouteHealthMonitorOpts {
  now?: () => number;
  markerPath?: string;
  cfg?: Partial<WebhookRouteHealthConfig>;
  onEmit?: (kind: "raised" | "recovered", verdict: RouteHealthVerdict) => void;
}

/**
 * Stateful wrapper that server.ts constructs once. Owns: the mutable state,
 * the latched/latchedAtMs episode metadata, latch hydration on first evaluate(),
 * atomic marker writes, and the sparse-warn gated console.warn line.
 *
 * The timer and the `console.warn` land in `orch-monitor.log`, which Alloy tails
 * and ships to Loki independently of the broken webhook path — so the alarm does
 * NOT ride the broken transport.
 */
export function createRouteHealthMonitor(opts: RouteHealthMonitorOpts = {}) {
  const now = opts.now ?? (() => Date.now());
  const cfg = resolveWebhookRouteHealthConfig(opts.cfg);
  const markerPath = opts.markerPath ?? getLinearWebhook401MarkerPath();
  const warn = createSparseWarnGate({ maxTracked: 2 });

  const state: WebhookRouteHealthState = initialRouteHealthState();
  let latched = false;
  let latchedAtMs: number | null = null;
  let hydrated = false;

  // Three-valued hydration (mirrors broker-degraded.mjs hydrateLatch):
  //   ENOENT / unparseable → CONFIRMED unlatched (hydrated = true, latched = false)
  //   other read error     → TRANSIENT (hydrated = false, retry next tick)
  function hydrate(): void {
    if (hydrated) return;
    let raw: string;
    try {
      raw = readFileSync(markerPath, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        hydrated = true;
        latched = false;
        latchedAtMs = null;
        return;
      }
      // Transient — leave hydrated=false so the next tick retries.
      return;
    }
    // Read succeeded → confirmed (even if unparseable).
    hydrated = true;
    try {
      const m = JSON.parse(raw) as Record<string, unknown>;
      latched = m?.latched === true;
      latchedAtMs = Number.isFinite(m?.latchedAtMs)
        ? (m.latchedAtMs as number)
        : null;
    } catch {
      latched = false;
      latchedAtMs = null;
    }
  }

  function writeMarker(nowMs: number): void {
    const m = buildRouteHealthMarker({
      latched,
      latchedAtMs,
      state,
      nowMs,
      host: hostname(),
    });
    const tmp = `${markerPath}.tmp.${process.pid}`;
    mkdirSync(dirname(markerPath), { recursive: true });
    writeFileSync(tmp, JSON.stringify(m));
    renameSync(tmp, markerPath);
  }

  function stampLinear(status: number): void {
    if (!cfg.enabled) return;
    const t = now();
    if (status >= 200 && status < 300) {
      state.lastLinear2xxMs = t;
    } else {
      state.lastLinearFailMs = t;
    }
  }

  function stampGithub(status: number): void {
    if (!cfg.enabled) return;
    if (status >= 200 && status < 300) {
      state.lastGithub2xxMs = now();
    }
  }

  function evaluate(): void {
    if (!cfg.enabled) return;
    hydrate();
    const nowMs = now();
    const v = classifyLinearWebhookHealth(state, nowMs, cfg);
    const edge = nextLinearWebhook401Latch(latched, v);

    if (edge.emit) {
      // EMIT-THEN-ADVANCE: persist first; only advance the latch on success.
      const nextLatched = edge.latched;
      const nextAt = edge.emit === "raised" ? nowMs : null;
      const prevLatched = latched;
      latched = nextLatched;
      latchedAtMs = nextAt;
      try {
        writeMarker(nowMs);
      } catch {
        // Rollback latch on write failure — retry same edge next tick.
        latched = prevLatched;
        latchedAtMs = edge.emit === "raised" ? null : latchedAtMs;
        return;
      }
      // Sparse-warn gated log line → orch-monitor.log → Alloy → Loki (independent path).
      const total = 1; // one alarm key per emit kind; gate dedups the flood.
      if (warn(`linear-webhook-401:${edge.emit}`, total)) {
        console.warn(
          `[linear-webhook-alarm] ${edge.emit.toUpperCase()}: /api/webhook/linear ` +
            `non-2xx-only for ${v.linearFailAgeMs}ms ` +
            `(last ok ${v.linearOkAgeMs ?? "never"}ms ago, ` +
            `github ok ${v.githubOkAgeMs}ms ago)`,
        );
      }
      opts.onEmit?.(edge.emit, v);
    } else if (latched) {
      // Refresh marker stamps while an episode is open (best-effort).
      try {
        writeMarker(nowMs);
      } catch {
        // ignore — marker will refresh on the next tick
      }
    }
  }

  function snapshot(): WebhookRouteHealthState {
    return { ...state };
  }

  return { stampLinear, stampGithub, evaluate, snapshot, config: cfg };
}
