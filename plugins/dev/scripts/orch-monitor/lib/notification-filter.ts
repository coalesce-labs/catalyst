import type { BoardAttention } from "./board-data.d.mts";

export type NotificationEvent =
  | {
      kind: "ticket";
      id: string;
      attention: BoardAttention;
      humanQuestion?: string;
      title?: string;
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

export interface NotificationProjectorOptions {
  /** Injectable clock (tests drive it directly). Defaults to Date.now. */
  now?: () => number;
  /** Override DAEMON_NOTIFY_HOLD_MS. 0 restores immediate-edge behavior. */
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
        } else {
          // Anchor on healthy-vs-NOT, not on the exact value, so a mid-hold
          // degraded→offline escalation does not restart the clock.
          if (healthy !== daemonHealthy) {
            daemonHealthy = healthy;
            daemonSince = t;
          }
          const held = t - daemonSince >= holdMs;
          if (!healthy) {
            const notifiedRank =
              daemonNotified === null ? 0 : DAEMON_RANK[daemonNotified];
            if (held && DAEMON_RANK[observed] > notifiedRank) {
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
