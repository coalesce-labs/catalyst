// Type declarations for respond-ticket.mjs (CTL-924, BFF12) — the read-model's
// SECOND write endpoint (HOME5's Answer / Unblock verb). Lets the strict TS
// server (server.ts) import respondTicket without a TS7016 implicit-any error.
// Keep in sync with the objects returned in respond-ticket.mjs.

import type { FenceOutcome } from "./stop-worker.d.mts";

/** Phase signal shape (the subset findHeldRun / respondTicket read). */
interface PhaseSignalLike {
  generation?: unknown;
  status?: unknown;
  phase?: unknown;
  ticket?: unknown;
  [key: string]: unknown;
}

/** The held run findHeldRun resolves: the parked phase + its verbatim signal. */
export interface HeldRun {
  phase: string;
  signal: PhaseSignalLike;
}

/** A canonical `linear.comment.created` resume event (the daemon's resume trigger). */
export interface ResumeEvent {
  ts: string;
  id: string;
  observedTs: string;
  severityText: "INFO";
  severityNumber: number;
  traceId: string;
  spanId: string;
  resource: Record<string, string>;
  attributes: Record<string, string>;
  body: { payload: Record<string, unknown> };
}

export function eventLogPath(opts?: {
  env?: Record<string, string | undefined>;
  now?: Date;
}): string;

export function buildResumeEvent(args: {
  ticket: string;
  response: unknown;
  now?: Date;
}): ResumeEvent;

export function emitResumeEvent(
  args: { ticket: string; response: unknown },
  opts?: {
    append?: (path: string, data: string) => void;
    pathFor?: (opts: { now: Date }) => string;
    mkdir?: (path: string, opts: { recursive: boolean }) => void;
    now?: Date;
  },
): { path: string; event: ResumeEvent };

export function clearNeedsHumanMarker(
  args: { ticket: string; label?: string },
  opts?: {
    workersDir?: string;
    rm?: (path: string) => void;
  },
): string[];

export function recordResponse(
  args: { ticket: string; phase: string; response: unknown; now?: Date },
  opts?: {
    workersDir?: string;
    write?: (path: string, data: string) => void;
    mkdir?: (path: string, opts: { recursive: boolean }) => void;
  },
): { path: string | null; record: Record<string, unknown> };

export function findHeldRun(
  ticket: string,
  opts?: {
    workersDir?: string;
    readDir?: (path: string) => string[];
    read?: (path: string, encoding: "utf8") => string;
  },
): HeldRun | null;

export function readClusterHostCount(opts?: {
  env?: Record<string, string | undefined>;
  read?: (path: string, encoding: "utf8") => string;
}): number;

export function runFenceCheck(
  args: { ticket: string; generation: number | null },
  opts?: {
    hostCount?: number;
    spawn?: unknown;
    nodeBin?: string;
    cli?: string;
    env?: Record<string, string | undefined>;
    timeout?: number;
  },
): FenceOutcome;

/**
 * Discriminated outcome of respondTicket; the route maps `status` to an HTTP code.
 * - not_held            → 404 (no parked needs-input run for the ticket)
 * - confirm_mismatch    → 400 (typed confirm did not match the ticket id)
 * - fenced              → 409 (verified-stale fence; a partitioned node rejected)
 * - fence_indeterminate → 409 (multi-host fence unconfirmed; refuse to mutate)
 * - resuming            → 200 (response recorded + marker cleared + resume emitted)
 */
export type RespondTicketResult =
  | { status: "not_held" }
  | { status: "confirm_mismatch"; expected: string }
  | { status: "fenced"; ticket: string; phase: string }
  | { status: "fence_indeterminate"; ticket: string; phase: string }
  | { status: "resuming"; ticket: string; phase: string; fenceNoop: boolean };

export function respondTicket(
  args: { ticket: string; response: unknown; confirm: unknown },
  opts?: {
    findHeld?: (ticket: string) => HeldRun | null;
    fenceCheck?: (args: { ticket: string; generation: number | null }) => FenceOutcome;
    record?: (args: { ticket: string; phase: string; response: unknown }) => unknown;
    clearMarker?: (args: { ticket: string }) => unknown;
    emit?: (args: { ticket: string; response: unknown }) => unknown;
  },
): RespondTicketResult;
