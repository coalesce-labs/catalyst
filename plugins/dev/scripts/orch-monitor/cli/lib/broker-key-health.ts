// broker-key-health.ts — read + render broker key-health for the HUD (CTL-343).

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export type ProbeStatus = "ok" | "missing" | "unauthorized" | "error" | "pending";

export interface BrokerKeyHealth {
  groq?: {
    present: boolean;
    source: string | null;
    prefix: string | null;
    probeStatus: ProbeStatus;
    probeError?: string | null;
    probeAt?: string | null;
    modelCount?: number | null;
  };
}

// CTL-403: active wait-loop session record surfaced in broker.state.json.
export interface WaitingSession {
  sessionId: string;
  ticket?: string | null;
  orchestrator?: string | null;
  waitFor?: string | null;
  timeoutAt: string;
  reason?: string | null;
}

// CTL-352: broader read of broker.state.json including the new liveness
// fields (interestCount, lastWakeAt, lastRegisterAt, startedAt). The legacy
// BrokerKeyHealth shape is preserved as a subset for existing consumers.
export interface BrokerState extends BrokerKeyHealth {
  interestCount?: number;
  lastWakeAt?: string | null;
  lastRegisterAt?: string | null;
  startedAt?: string;
  // CTL-403: sessions currently blocking in a wait-for loop.
  waitingSessions?: WaitingSession[];
  /** CTL-421: whether CATALYST_BROKER_PROSE_ENABLED=1 was set when the broker started. */
  proseEnabled?: boolean;
}

export type BrokerInterestStatus = "ok" | "startup" | "degraded" | "unknown";

const DEGRADED_GRACE_MS = 5 * 60 * 1000;

/** Path of the broker's state file (override via $BROKER_STATE_FILE). */
export function brokerStateFilePath(): string {
  if (process.env.BROKER_STATE_FILE) return process.env.BROKER_STATE_FILE;
  const dir = process.env.CATALYST_DIR ?? resolve(homedir(), "catalyst");
  return resolve(dir, "broker.state.json");
}

export function readBrokerKeyHealth(path?: string): BrokerKeyHealth | null {
  const target = path ?? brokerStateFilePath();
  try {
    const parsed: unknown = JSON.parse(readFileSync(target, "utf8"));
    if (parsed && typeof parsed === "object" && "keyHealth" in parsed) {
      const kh = (parsed as { keyHealth?: BrokerKeyHealth }).keyHealth;
      return kh ?? null;
    }
    return null;
  } catch {
    return null;
  }
}

/** Three-letter chip label for a probe status. */
export function chipLabel(status: ProbeStatus): string {
  switch (status) {
    case "ok": return "OK";
    case "missing": return "MISS";
    case "unauthorized": return "401";
    case "error": return "ERR";
    case "pending": return "...";
  }
}

/** Ink color name for a probe status. */
export function chipColor(status: ProbeStatus): string {
  switch (status) {
    case "ok": return "green";
    case "missing": return "yellow";
    case "unauthorized": return "red";
    case "error": return "red";
    case "pending": return "cyan";
  }
}

// CTL-352: broker.state.json reader that surfaces liveness fields in
// addition to keyHealth. Returns null on missing file / parse error so
// consumers can render an "unknown" chip without crashing.
export function readBrokerState(path?: string): BrokerState | null {
  const target = path ?? brokerStateFilePath();
  try {
    const parsed: unknown = JSON.parse(readFileSync(target, "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    const obj = parsed as Record<string, unknown>;
    const kh = (obj.keyHealth ?? null) as BrokerKeyHealth | null;
    const result: BrokerState = { ...(kh ?? {}) };
    if (typeof obj.interestCount === "number") result.interestCount = obj.interestCount;
    if (typeof obj.lastWakeAt === "string" || obj.lastWakeAt === null) {
      result.lastWakeAt = obj.lastWakeAt;
    }
    if (typeof obj.lastRegisterAt === "string" || obj.lastRegisterAt === null) {
      result.lastRegisterAt = obj.lastRegisterAt;
    }
    if (typeof obj.startedAt === "string") result.startedAt = obj.startedAt;
    // CTL-403: parse waitingSessions array.
    if (Array.isArray(obj.waitingSessions)) {
      result.waitingSessions = obj.waitingSessions
        .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
        .map((s) => ({
          sessionId: typeof s.sessionId === "string" ? s.sessionId : "",
          ticket: typeof s.ticket === "string" ? s.ticket : null,
          orchestrator: typeof s.orchestrator === "string" ? s.orchestrator : null,
          waitFor: typeof s.waitFor === "string" ? s.waitFor : null,
          timeoutAt: typeof s.timeoutAt === "string" ? s.timeoutAt : "",
          reason: typeof s.reason === "string" ? s.reason : null,
        }))
        .filter((s) => s.sessionId && s.timeoutAt);
    }
    if (typeof obj.proseEnabled === "boolean") result.proseEnabled = obj.proseEnabled;
    return result;
  } catch {
    return null;
  }
}

// CTL-352: classify the broker's interest table for HUD pill colouring.
// "ok" — there is at least one registered interest.
// "startup" — table is empty but broker has been up < 5 min (warmup grace).
// "degraded" — table is empty AND broker has been up > 5 min (the silent-dead
//   mode CTL-350 surfaced).
// "unknown" — state file missing/malformed or interestCount field absent.
export function brokerInterestStatus(
  state: BrokerState | null,
  nowMs: number = Date.now(),
): BrokerInterestStatus {
  if (!state || typeof state.interestCount !== "number") return "unknown";
  if (state.interestCount > 0) return "ok";
  if (!state.startedAt) return "unknown";
  const started = Date.parse(state.startedAt);
  if (Number.isNaN(started)) return "unknown";
  return nowMs - started > DEGRADED_GRACE_MS ? "degraded" : "startup";
}

export function interestChipColor(status: BrokerInterestStatus): string {
  switch (status) {
    case "ok": return "green";
    case "startup": return "yellow";
    case "degraded": return "red";
    case "unknown": return "gray";
  }
}

export function interestChipLabel(
  state: BrokerState | null,
  status: BrokerInterestStatus,
): string {
  if (status === "unknown" || !state || typeof state.interestCount !== "number") return "?";
  const n = state.interestCount;
  if (status === "ok") return `${n} interest${n === 1 ? "" : "s"}`;
  if (status === "startup") return `${n} (starting)`;
  return `${n} interests`;
}
