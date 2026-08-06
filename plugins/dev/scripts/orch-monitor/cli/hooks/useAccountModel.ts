// useAccountModel.ts — CTL-1653. Subscribe the HUD to THIS node's Claude-account
// posture over the LOCAL monitor's `/api/accounts/stream` SSE. Unlike the read
// model (which may point at a remote replica), account posture is inherently
// per-node/local, so this always targets the local monitor
// (ACCOUNT_MONITOR_URL, else http://127.0.0.1:<MONITOR_PORT|7400>).
//
// Deliberately does NOT read CATALYST_MONITOR_URL: read-model-url.ts documents
// that override as the first-precedence base for a developer node reading a
// WORKER's remote monitor for board data. Honoring it here too would stream the
// REMOTE worker's account posture under this (local) node's strip/banner —
// account posture is node-scoped, so it needs its own, distinct escape hatch.
//
// Uses the HUD's dependency-free createNodeEventSource (no browser EventSource in
// bun). createNodeEventSource is a ONE-SHOT reader (reconnect policy is the hook's
// job), so this hook owns capped-backoff reconnect + a snapshot reconcile — without
// it the strip would freeze on its last value forever the first time the local
// monitor restarts or the stream drops. Reconnects on BOTH an errored close
// (onerror) and a CLEAN end-of-stream (whenIdle() resolving with no prior
// onerror — a graceful monitor restart / proxy close never fires onerror; see
// shouldReconnectOnIdle). Never throws.

import { useEffect, useState } from "react";
import { createNodeEventSource, type NodeEventSource } from "../lib/node-event-source";
import { DEFAULT_MONITOR_PORT } from "../lib/read-model-url";
import type { AccountStripSignal } from "../components/account-strip";

const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 15_000;

/**
 * shouldReconnectOnIdle — pure decision for whether a NodeEventSource's clean
 * end-of-stream (its `whenIdle()` resolving with NO prior `onerror`) should
 * trigger a reconnect. A clean EOF happens when the monitor restarts or a
 * proxy closes the connection gracefully — `createNodeEventSource`'s `pump()`
 * returns normally on `done` from the reader in that case, never invoking
 * `onerror`, so a hook that only reconnects from `onerror` freezes the strip
 * on its last value forever (CTL-1653 Codex round-2 finding). Exported so the
 * three guards are independently testable without a DOM, timers, or a real
 * EventSource — bun's test runner has no React-hook renderer (see
 * useFilter.test.ts for the established pattern this mirrors).
 *
 * @param handled   true if `onerror` already handled this connection's end
 *                  (an errored close reconnects via its own onerror path —
 *                  reconnecting here too would double-schedule)
 * @param alive     false once the component has unmounted — never reconnect
 *                  after teardown
 * @param isCurrent false when a newer connection has already superseded this
 *                  one — this stale `whenIdle()` resolving late must not
 *                  reconnect a second time
 */
export function shouldReconnectOnIdle({
  handled,
  alive,
  isCurrent,
}: {
  handled: boolean;
  alive: boolean;
  isCurrent: boolean;
}): boolean {
  return !handled && alive && isCurrent;
}

/** Resolve the LOCAL monitor base URL (no path). */
function localMonitorBase(env: Record<string, string | undefined>): string {
  const explicit = env.ACCOUNT_MONITOR_URL?.trim().replace(/\/+$/, "");
  if (explicit) return explicit;
  const parsed = parseInt(env.MONITOR_PORT ?? "", 10);
  const port = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MONITOR_PORT;
  return `http://127.0.0.1:${port}`;
}

/**
 * What to do with a raw (already JSON.parse'd) `/api/accounts` body or SSE
 * `account` frame payload: apply a valid posture, CLEAR to unavailable, or
 * ignore malformed/garbage input untouched.
 *
 * MIRROR of ui/src/hooks/account-signal-lib.ts's `accountFrameAction` — same
 * three-way contract, hand-synced per this file's cli/lib mirroring
 * convention (see account-strip.ts's "MIRROR, not import" note: the cli
 * bundle never reaches into ui/src). CTL-1653 Codex round-3 finding: before
 * this existed, the HUD's decode returned null for BOTH garbage AND the
 * documented `{available:false}` frame, so an already-open HUD kept showing
 * a stale posture after a node's env file was emptied/reset-to-placeholders
 * instead of clearing — the round-2 fix closed this gap on the web dashboard
 * (accountFrameAction) but missed the HUD's separate decode path.
 */
export type AccountFrameAction =
  | { type: "apply"; signal: AccountStripSignal }
  | { type: "clear" }
  | { type: "ignore" };

export function accountFrameAction(value: unknown): AccountFrameAction {
  if (!value || typeof value !== "object") return { type: "ignore" };
  const p = value as Record<string, unknown>;
  if (typeof p.status === "string") {
    return { type: "apply", signal: p as unknown as AccountStripSignal };
  }
  if (p.available === false) return { type: "clear" };
  return { type: "ignore" };
}

/**
 * Subscribe to the local account-posture stream for the calling component's
 * lifetime. Returns the latest posture (null until the first frame lands / when
 * the endpoint is unavailable).
 */
export function useAccountModel(): AccountStripSignal | null {
  const [signal, setSignal] = useState<AccountStripSignal | null>(null);

  useEffect(() => {
    let alive = true;
    const base = localMonitorBase(process.env);
    let es: NodeEventSource | null = null;
    let backoff = INITIAL_BACKOFF_MS;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    const applySignal = (next: AccountStripSignal | null) => {
      if (alive) setSignal(next);
    };

    // Dispatch a raw (already JSON-parsed) frame/body per accountFrameAction:
    // apply a valid posture, CLEAR to unavailable (a REAL transition, not
    // noise — must reach the strip), or ignore malformed input untouched.
    const dispatch = (raw: unknown) => {
      const action = accountFrameAction(raw);
      if (action.type === "apply") applySignal(action.signal);
      else if (action.type === "clear") applySignal(null);
    };

    // Snapshot from /api/accounts so the strip populates immediately (and re-seeds
    // after a drop), not only on the next stream frame. Best-effort.
    const reconcile = async () => {
      try {
        const r = await fetch(`${base}/api/accounts`);
        if (r.ok && alive) {
          const body: unknown = await r.json();
          dispatch(body);
        }
      } catch {
        /* offline — the stream (or a later snapshot) will populate it */
      }
    };

    const scheduleReconnect = () => {
      if (!alive) return;
      const delay = backoff;
      backoff = Math.min(MAX_BACKOFF_MS, backoff * 2);
      reconnectTimer = setTimeout(connect, delay);
      void reconcile();
    };

    function connect() {
      if (!alive) return;
      let src: NodeEventSource;
      try {
        src = createNodeEventSource(`${base}/api/accounts/stream`);
      } catch {
        scheduleReconnect();
        return;
      }
      es = src;
      let handled = false; // true once onerror has already handled this src's end
      src.addEventListener("account", (ev) => {
        backoff = INITIAL_BACKOFF_MS; // reset on a real frame
        let parsed: unknown;
        try {
          parsed = JSON.parse(ev.data);
        } catch {
          return; // truncated/garbage frame — ignore
        }
        dispatch(parsed);
      });
      src.onerror = () => {
        handled = true;
        // One-shot reader errored (monitor restart / stream drop) — close and
        // reconnect with capped backoff so the strip resumes updating.
        try {
          src.close();
        } catch {
          /* noop */
        }
        if (es === src) es = null;
        scheduleReconnect();
      };
      // A CLEAN end-of-stream never fires onerror (see shouldReconnectOnIdle's
      // doc comment) — without this, the strip freezes forever the first time
      // the local monitor restarts gracefully instead of dropping the
      // connection with an error. onerror (when it fires) always completes
      // synchronously before whenIdle() resolves, so `handled` is accurate by
      // the time this runs.
      void src
        .whenIdle()
        .then(() => {
          if (!shouldReconnectOnIdle({ handled, alive, isCurrent: es === src })) return;
          es = null;
          scheduleReconnect();
        })
        .catch(() => {
          /* whenIdle() never rejects in practice; defensive no-op */
        });
    }

    void reconcile();
    connect();

    return () => {
      alive = false;
      clearTimeout(reconnectTimer);
      try {
        es?.close();
      } catch {
        /* noop */
      }
      es = null;
    };
  }, []);

  return signal;
}
