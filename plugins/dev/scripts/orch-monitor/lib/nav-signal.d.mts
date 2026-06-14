// Type declarations for nav-signal.mjs (CTL-896 / SHELL6 nav-signal projection).
import type { BoardPayload } from "./board-data.mjs";
import type { HostLivenessStatus, LivenessThresholds } from "./node-liveness.mjs";

/** The footer daemon-health vocabulary (mapped from node-liveness status). */
export type DaemonHealth = "healthy" | "degraded" | "offline";

/** The single nav-signal projection that feeds the rail's live badges/dots. */
export interface NavSignal {
  /** Active execution-core workers — the Workers nav badge. */
  workerCount: number;
  /** Tickets waiting in the queue — the Queue nav badge. */
  queueDepth: number;
  /** A board anomaly exists (blocked/needs-human or a stuck worker) — the Board amber dot. */
  anomaly: boolean;
  /** The local daemon's liveness — the footer health dot. */
  daemon: DaemonHealth;
  /** The source snapshot's generatedAt (passthrough for cache/debug; "" when absent). */
  generatedAt: string;
}

/** Project the four nav signals off a board snapshot + the local daemon liveness. */
export function deriveNavSignal(
  board: BoardPayload | null | undefined,
  opts?: { daemon?: DaemonHealth; liveness?: HostLivenessStatus },
): NavSignal;

/** Classify the LOCAL daemon's health from the heartbeat last-seen map. */
export function deriveDaemonHealth(
  lastSeenByHost: Record<string, string>,
  localHostName: string,
  opts?: { now?: number } & LivenessThresholds,
): DaemonHealth;
