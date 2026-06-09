// nav-signal.ts — the UI contract for the read-model's nav-signal projection
// (CTL-896 / SHELL6). The rail's live badges/dots — Workers active count, Queue
// depth, the Board anomaly dot, and the footer daemon-health dot — are fed by the
// server's `/api/nav` + `/api/nav/stream` projection (lib/nav-signal.mjs), NOT by
// hardcoded mocks and NOT by a per-tab tail of the source files.
//
// This module is the browser-side mirror of the server's `NavSignal` shape plus a
// structural decode guard, kept deliberately runtime-free + pure so it is unit-
// testable without a DOM (the same pattern lib/surface.ts and the read-model
// client contract follow). The subscription lifecycle lives in
// hooks/use-nav-signal.ts; the badge/dot wiring lives in components/app-sidebar.tsx.

/** The footer daemon-health vocabulary (mirrors the server's nav-signal.mjs). */
export type DaemonHealth = "healthy" | "degraded" | "offline";

/** The four nav signals the rail renders — the server's NavSignal wire shape. */
export interface NavSignal {
  /** Active execution-core workers — the Workers nav badge. */
  workerCount: number;
  /** Tickets waiting in the queue — the Queue nav badge. */
  queueDepth: number;
  /** A board anomaly exists (blocked/needs-human or a stuck worker) — the Board amber dot. */
  anomaly: boolean;
  /** The local daemon's liveness — the footer health dot (emerald/amber/red). */
  daemon: DaemonHealth;
  /** The source snapshot's generatedAt (passthrough for dedupe/debug). */
  generatedAt: string;
}

const DAEMON_VALUES: readonly DaemonHealth[] = ["healthy", "degraded", "offline"];

/** Structural guard: keep a truncated/garbage SSE frame from reaching the rail. */
export function isNavSignal(value: unknown): value is NavSignal {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.workerCount === "number" &&
    typeof v.queueDepth === "number" &&
    typeof v.anomaly === "boolean" &&
    typeof v.daemon === "string" &&
    (DAEMON_VALUES as readonly string[]).includes(v.daemon) &&
    typeof v.generatedAt === "string"
  );
}

/** Decode an SSE `nav` frame's data; returns null (skipped) on garbage. */
export function decodeNavSignalFrame(data: string): NavSignal | null {
  try {
    const parsed: unknown = JSON.parse(data);
    return isNavSignal(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** The Tailwind dot color for a daemon-health status — emerald/amber/red. The
 *  cyan #5be0ff live-signal color is RESERVED and deliberately NOT used here. */
export function daemonDotClass(daemon: DaemonHealth): string {
  if (daemon === "healthy") return "bg-emerald-500";
  if (daemon === "degraded") return "bg-amber-500";
  return "bg-red-500";
}

/** The human label for a daemon-health status (tooltip + aria-label). */
export function daemonLabel(daemon: DaemonHealth): string {
  if (daemon === "healthy") return "Daemon healthy";
  if (daemon === "degraded") return "Daemon degraded";
  return "Daemon offline";
}
