// account-signal-lib.ts — CTL-1653. The UI contract for the read-model's per-node
// Claude-account posture (`/api/accounts` + `/api/accounts/stream`). Browser-side
// mirror of the server's AccountsSummary shape (lib/accounts-probe.mjs) plus a
// structural decode guard and the SINGLE canonical status→tone/copy mapping shared
// by the footer indicator, the loud banner (Phase 5), and the HUD strip (Phase 6).
//
// Deliberately runtime-free + pure so it is unit-testable without a DOM (same
// pattern lib/cluster-signal.ts follows). The subscription lifecycle lives in
// hooks/use-account-signal.ts.
//
// error ≠ rejected: a transport `error` is "the sensor is broken" (MUTED, never
// loud); only `rejected` (account exhausted) trips the loud banner/overlay.

/** One rate-limit window's utilization/reset/status (token-free). */
export interface AccountWindow {
  pct?: number;
  resetsAt?: string | null;
  status?: string | null;
}

/** A token-free per-account view mirrored from the server. */
export interface AccountView {
  label?: string | null;
  email?: string | null;
  overallStatus?: string | null;
  representativeClaim?: string | null;
  bindingWindow?: string | null;
  bindingStatus?: string | null;
  fiveHour?: AccountWindow | null;
  sevenDay?: AccountWindow | null;
  error?: string | null;
}

/** The node status derived from the active account's binding window. */
export type AccountNodeStatus = "ok" | "degraded" | "rejected" | "error" | "unknown";

/** The per-node account posture wire shape the dashboards render. */
export interface AccountSignal {
  node?: string | null;
  status: AccountNodeStatus;
  active?: AccountView | null;
  siblingWithHeadroom?: { label: string | null; email: string | null } | null;
  generatedAt?: string | null;
}

const STATUS_VALUES: readonly AccountNodeStatus[] = [
  "ok",
  "degraded",
  "rejected",
  "error",
  "unknown",
];

/** Structural guard: keep a truncated/garbage SSE frame from reaching the UI. */
export function isAccountSignal(value: unknown): value is AccountSignal {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.status === "string" &&
    (STATUS_VALUES as readonly string[]).includes(v.status) &&
    (v.active === null || v.active === undefined || typeof v.active === "object")
  );
}

/** Decode an SSE `account` frame's data; returns null (skipped) on garbage. */
export function decodeAccountSignalFrame(data: string): AccountSignal | null {
  try {
    const parsed: unknown = JSON.parse(data);
    return isAccountSignal(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Structural guard: the documented `{available:false}` unavailable contract
 * (disabled probe / no-env-file — see lib/accounts-probe.mjs deriveAccountsSummary
 * and server.ts's /api/accounts). Distinct from `isAccountSignal`'s garbage check —
 * this is a well-formed, DOCUMENTED response shape, not noise.
 */
export function isAccountUnavailable(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  return (value as Record<string, unknown>).available === false;
}

/**
 * What a consumer should do with a raw `/api/accounts` body or SSE `account`
 * frame payload (already JSON-parsed): apply a valid signal, clear to the
 * unavailable state, or ignore malformed/garbage input untouched.
 *
 * CTL-1653 Codex finding (stale-strip): before this existed, a decode that
 * returned null for BOTH garbage AND the well-formed `{available:false}` frame
 * meant callers treated a genuine "probe went unavailable" transition as a
 * no-op — the footer/banner kept rendering a stale rejected/ok posture forever
 * once the env file was removed or the probe was disabled. `clear` is the fix:
 * it is a real state transition, not noise, and must reach the UI.
 */
export type AccountFrameAction =
  | { type: "apply"; signal: AccountSignal }
  | { type: "clear" }
  | { type: "ignore" };

export function accountFrameAction(value: unknown): AccountFrameAction {
  if (isAccountSignal(value)) return { type: "apply", signal: value };
  if (isAccountUnavailable(value)) return { type: "clear" };
  return { type: "ignore" };
}

/** The tone vocabulary shared by the footer indicator + HUD strip. */
export type AccountTone = "quiet" | "warn" | "loud" | "muted";

const STATUS_TONE: Record<AccountNodeStatus, AccountTone> = {
  ok: "quiet",
  unknown: "quiet",
  degraded: "warn",
  rejected: "loud",
  error: "muted",
};

/** Short label for a binding window (five_hour → "5h", seven_day → "7d"). */
export function bindingWindowShort(bindingWindow?: string | null): string {
  if (bindingWindow === "five_hour") return "5h";
  if (bindingWindow === "seven_day") return "7d";
  return "";
}

/** The window object the binding claim points at (five_hour → active.fiveHour). */
export function bindingWindowOf(active?: AccountView | null): AccountWindow | null {
  if (!active) return null;
  if (active.bindingWindow === "five_hour") return active.fiveHour ?? null;
  if (active.bindingWindow === "seven_day") return active.sevenDay ?? null;
  return null;
}

/**
 * accountIndicatorLabel — the compact, quiet-while-ok footer/strip label. Names the
 * active handle + binding-window pct; the tone is the single canonical status map
 * (ok/unknown quiet, degraded warn, rejected loud, error muted).
 */
export function accountIndicatorLabel(signal: AccountSignal | null | undefined): {
  text: string;
  tone: AccountTone;
} {
  if (!signal) return { text: "account —", tone: "muted" };
  const tone = STATUS_TONE[signal.status] ?? "muted";
  const active = signal.active;
  if (!active || (!active.label && signal.status === "unknown")) {
    return { text: "no active account", tone };
  }
  if (signal.status === "error") {
    return { text: `${active.label ?? "account"} · error`, tone };
  }
  const win = bindingWindowShort(active.bindingWindow);
  const w = bindingWindowOf(active);
  const pct = typeof w?.pct === "number" ? `${w.pct}%` : "";
  const parts = [active.label ?? "account", [win, pct].filter(Boolean).join(" ")].filter(Boolean);
  return { text: parts.join(" · "), tone };
}

/** The loud banner/overlay model — non-null ONLY when the active binding is rejected. */
export interface AccountBannerModel {
  handle: string | null;
  resetsAt: string | null;
  sibling: { label: string | null; email: string | null } | null;
}

/**
 * bannerModel — the loud model for the web banner / HUD overlay. Returns null unless
 * the active account's binding window is `rejected` (an `error` sensor failure is
 * NOT loud). Names the binding window's reset time + a sibling with headroom.
 */
export function bannerModel(signal: AccountSignal | null | undefined): AccountBannerModel | null {
  if (!signal || signal.status !== "rejected") return null;
  const active = signal.active ?? null;
  const w = bindingWindowOf(active);
  return {
    handle: active?.label ?? null,
    resetsAt: w?.resetsAt ?? null,
    sibling: signal.siblingWithHeadroom ?? null,
  };
}
