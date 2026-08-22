import type { BoardAttention } from "./board-data.d.mts";

export type NotificationEvent =
  | {
      kind: "ticket";
      id: string;
      attention: BoardAttention;
      humanQuestion?: string;
      title?: string;
      /** CAT-170: "anchor" | "member" | null. A correlated incident labels every
       *  member needs-human, but only the anchor may notify — see shouldNotify. */
      correlationRole?: string | null;
    }
  | { kind: "daemon"; to: "healthy" | "degraded" | "offline" }
  | { kind: "anomaly" };

export interface PushNotification {
  title: string;
  body: string;
  deepLink: string;
}

// Notification template strings — single source of truth for all five categories
// (service worker, push bridge, SSE). Change here, propagates everywhere.
const TMPL = {
  TICKET_NEEDS_DECISION: "needs your decision",
  TICKET_WAITING: "is waiting on you",
  TICKET_FALLBACK_BODY: "needs your attention",
  DAEMON_RECOVERED_TITLE: "Catalyst — daemon recovered",
  DAEMON_RECOVERED_BODY: "Fleet daemon is healthy again",
  DAEMON_DEGRADED_TITLE: "Catalyst — daemon degraded",
  ANOMALY_TITLE: "Catalyst — board anomaly",
  ANOMALY_BODY: "A board anomaly was detected — take a look",
} as const;

export function shouldNotify(ev: NotificationEvent): PushNotification | null {
  if (ev.kind === "ticket") {
    if (ev.attention === null) return null;
    // CAT-170: collapse a correlated incident to ONE alert. Every correlated
    // ticket still carries its own needs-human label, signal and board card —
    // only the PUSH is suppressed for members, so the operator gets a single
    // "<anchor> needs your decision" instead of one notification per member.
    // Unknown/absent role (the uncorrelated singleton case) notifies as before.
    if (ev.correlationRole === "member") return null;
    const label =
      ev.attention === "needs-human"
        ? TMPL.TICKET_NEEDS_DECISION
        : TMPL.TICKET_WAITING;
    const body =
      (ev.humanQuestion && ev.humanQuestion.length > 0
        ? ev.humanQuestion
        : undefined) ??
      (ev.title && ev.title.length > 0 ? ev.title : undefined) ??
      TMPL.TICKET_FALLBACK_BODY;
    return { title: `${ev.id} ${label}`, body, deepLink: `/?ticket=${ev.id}` };
  }
  if (ev.kind === "daemon") {
    return ev.to === "healthy"
      ? {
          title: TMPL.DAEMON_RECOVERED_TITLE,
          body: TMPL.DAEMON_RECOVERED_BODY,
          deepLink: "/",
        }
      : {
          title: TMPL.DAEMON_DEGRADED_TITLE,
          body: `Daemon state: ${ev.to}`,
          deepLink: "/",
        };
  }
  // kind === "anomaly"
  return {
    title: TMPL.ANOMALY_TITLE,
    body: TMPL.ANOMALY_BODY,
    deepLink: "/",
  };
}

// Minimal board shape consumed by the projector — a structural subset of
// BoardPayload + NavSignal so no runtime .mjs dep is needed in tests.
export interface ProjectorBoard {
  tickets?: Array<{
    id: string;
    attention: BoardAttention;
    attentionSince?: string | null;
    humanQuestion?: string;
    title?: string;
    /** CAT-170: correlation role projected by board-data's deriveAttention. */
    correlationRole?: string | null;
  }>;
  daemon?: "healthy" | "degraded" | "offline";
  anomaly?: boolean;
}

export type DaemonHealth = "healthy" | "degraded" | "offline";

// CTL-1522: how long a non-healthy daemon state must HOLD before it pushes.
// Calibrated on mini (July: 59,013 node.heartbeat, median gap 31s, p99 102s,
// max 268s, ZERO gaps >300s): the daemon has never actually gone offline from
// jitter, yet 1,100 gaps crossed the 90s DEFAULT_DAEMON_HEALTHY_WINDOW_MS and
// each one pushed a degraded AND a recovered — ~300 phone pushes/day, all false.
// A 180s hold means a push needs a heartbeat gap >270s, which no observed
// non-restart gap reaches.
export const DAEMON_NOTIFY_HOLD_MS = 180_000;

// Severity ladder. Notifications fire on ESCALATION only (rank increases), so a
// steady degraded does not repeat and an offline→degraded improvement does not
// buzz. Deliberately NOT the same as "the value changed" — that was the bug.
const DAEMON_RANK: Record<DaemonHealth, number> = {
  healthy: 0,
  degraded: 1,
  offline: 2,
};

/**
 * Parse the MONITOR_DAEMON_NOTIFY_HOLD_MS override with the documented fallback
 * semantics. Valid: a finite value >= 0, INCLUDING an explicit 0 (opt-out: no
 * hold). Invalid → undefined → the caller's default. Invalid means unset, empty
 * or whitespace-only, non-numeric, OR negative.
 *
 * A bare `Number(env)` coerces "" to 0 and accepts negatives, either of which
 * silently disables the hold and restores the notification storm. Mirrors
 * resolveRestoreHoldMs (execution-core/config.mjs), which exists because
 * CTL-1091 hit exactly this trap. Codex P2, PR #2739. Exported for unit tests.
 */
export function resolveDaemonNotifyHoldMs(
  raw: string | undefined,
): number | undefined {
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export interface NotificationProjectorOptions {
  /** Injectable clock (tests drive it directly). Defaults to Date.now. */
  now?: () => number;
  /**
   * Override DAEMON_NOTIFY_HOLD_MS. 0 disables the hold, so escalations notify
   * on the frame they are observed.
   *
   * NOTE: 0 is "no hold", NOT a byte-identical rollback to the pre-CTL-1522
   * transition-based projector. Two suppressions are unconditional design
   * properties and are deliberately NOT governed by the hold (Codex P2, #2739):
   *   - a non-healthy value observed on the SEEDING frame is still announced
   *     once it satisfies the hold. Suppressing it would mean a monitor that
   *     restarts into an ongoing outage never reports it — the
   *     stale-copy-reports-healthy failure mode.
   *   - a "recovered" is never emitted for an episode that never announced a
   *     degraded, so a blip cannot produce an orphan recovery.
   */
  daemonNotifyHoldMs?: number;
}

export function createNotificationProjector(
  opts: NotificationProjectorOptions = {},
) {
  const now = opts.now ?? ((): number => Date.now());
  const holdMs = opts.daemonNotifyHoldMs ?? DAEMON_NOTIFY_HOLD_MS;
  let prevAnomaly: boolean | undefined;
  const fired = new Set<string>();

  // CTL-1522 daemon-notify state. The hold clock is anchored at the
  // healthy→unhealthy transition and is deliberately NOT restarted when the
  // value escalates degraded→offline. That single property is what lets one
  // uniform hold satisfy both requirements at once:
  //   - a REAL death still escalates on time. Heartbeat stops at t=0; the board
  //     reads degraded at t=90s (anchor); the degraded push fires at t=270s; the
  //     board reads offline at t=300s and — because the hold already elapsed —
  //     the offline push fires immediately at ~300s, exactly as before.
  //   - a SPURIOUS one-frame offline is absorbed. productionDaemonHealth
  //     (server.ts) returns "offline" from a bare catch, so any transient
  //     heartbeat-read throw used to be an instant phone push; now it must
  //     persist past the hold to say anything.
  let daemonSeeded = false;
  let daemonHealthy: boolean | undefined;
  let daemonSince = 0;
  // The exact observed value and when it last changed. Separate from
  // daemonHealthy/daemonSince (which track only healthy-vs-not) because an
  // escalation INSIDE an already-announced episode is held on its own value —
  // see the ready check below.
  let daemonObserved: DaemonHealth | undefined;
  let daemonValueSince = 0;
  // The most severe state this episode has already announced; null = no open
  // episode. Gates both the repeat-suppression and the paired recovery: a blip
  // that never pushed can never push an orphan "recovered".
  let daemonNotified: DaemonHealth | null = null;

  return {
    project(board: ProjectorBoard): PushNotification[] {
      const out: PushNotification[] = [];

      for (const t of board.tickets ?? []) {
        if (!t.attention) continue;
        const key = `ticket:${t.id}:${t.attentionSince ?? ""}`;
        if (fired.has(key)) continue;
        const n = shouldNotify({
          kind: "ticket",
          id: t.id,
          attention: t.attention,
          humanQuestion: t.humanQuestion,
          title: t.title,
          correlationRole: t.correlationRole, // CAT-170
        });
        if (n) {
          out.push(n);
          fired.add(key);
        }
      }

      if (board.daemon !== undefined) {
        const t = now();
        const observed = board.daemon;
        const healthy = observed === "healthy";

        if (!daemonSeeded) {
          // First frame only ever seeds. The projector has no prior state to
          // compare against, so it must not announce whatever it happens to
          // observe first — preserved verbatim from the pre-hold behavior.
          daemonSeeded = true;
          daemonHealthy = healthy;
          daemonSince = t;
          daemonObserved = observed;
          daemonValueSince = t;
        } else {
          // Anchor on healthy-vs-NOT, not on the exact value, so a mid-hold
          // degraded→offline escalation does not restart the clock.
          if (healthy !== daemonHealthy) {
            daemonHealthy = healthy;
            daemonSince = t;
          }
          if (observed !== daemonObserved) {
            daemonObserved = observed;
            daemonValueSince = t;
          }
          const held = t - daemonSince >= holdMs;
          if (!healthy) {
            const notifiedRank =
              daemonNotified === null ? 0 : DAEMON_RANK[daemonNotified];
            // The FIRST announcement of an episode rides the healthy→unhealthy
            // anchor, so a real death is announced on time and reports whatever
            // it has escalated to by then. A LATER escalation inside an already
            // announced episode must clear the hold on its OWN value — otherwise
            // one spurious `offline` frame (productionDaemonHealth's bare catch)
            // buzzes a second time even though the transient never persisted.
            // Codex P2, PR #2739.
            const ready =
              daemonNotified === null ? held : t - daemonValueSince >= holdMs;
            if (ready && DAEMON_RANK[observed] > notifiedRank) {
              const n = shouldNotify({ kind: "daemon", to: observed });
              if (n) out.push(n);
              daemonNotified = observed;
            }
          } else if (daemonNotified !== null && held) {
            const n = shouldNotify({ kind: "daemon", to: "healthy" });
            if (n) out.push(n);
            daemonNotified = null;
          }
        }
      }

      if (board.anomaly !== undefined) {
        if (prevAnomaly === false && board.anomaly === true) {
          const n = shouldNotify({ kind: "anomaly" });
          if (n) out.push(n);
        }
        prevAnomaly = board.anomaly;
      }

      return out;
    },
  };
}
