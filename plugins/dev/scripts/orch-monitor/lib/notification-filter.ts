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

export function createNotificationProjector() {
  let prevDaemon: "healthy" | "degraded" | "offline" | undefined;
  let prevAnomaly: boolean | undefined;
  const fired = new Set<string>();

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
        if (prevDaemon !== undefined && prevDaemon !== board.daemon) {
          const n = shouldNotify({ kind: "daemon", to: board.daemon });
          if (n) out.push(n);
        }
        prevDaemon = board.daemon;
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
