// live-screen-pane.tsx — the worker "Live screen" pane (CTL-938), the
// PRE-transcript wedge window on the worker detail page.
//
// The transcript live-tail (CTL-918) only covers workers that have started a
// turn. The workers an operator most needs to see — wedged at session start
// ("Unknown command: /catalyst-dev:phase-plan"), blocked on a dialog, idle at
// an empty prompt — have NO transcript at all. Their rendered terminal screen
// IS available: this pane consumes the change-driven SSE at
// /api/ec-worker-screen/<shortId> (server polls `claude logs <shortId>` ~2s,
// ANSI-normalizes, diffs, pushes only CHANGED full-screen frames) and renders
// it as a dark monospace terminal with a "last change Xs ago" indicator and
// the frozen-screen WEDGE label (ticket Scenario 2). Once the transcript
// live-tail has rows, the pane steps back to standby (Scenario 3 hand-off) —
// the richer per-event tail takes over, but the screen stays one click away.
//
// All logic lives in the PURE live-screen-data.ts; this file is the skin + the
// EventSource lifecycle only. NOTHING here imports a server module (the
// vite.config bun:sqlite build trap — lib/ec-worker-screen.mjs is server-only).

import { useEffect, useRef, useState } from "react";
import {
  shortIdFromBgJobId,
  parseScreenFrame,
  applyScreenFrame,
  deriveScreenStatus,
  deriveScreenPaneMode,
  fmtScreenAge,
  type ScreenViewState,
} from "./live-screen-data";
import { LIVE_CYAN } from "./detail-chrome";

// Mirror worker-detail-body.tsx's inline-`C` palette (same Shell tokens).
const C = {
  s2: "#161a21",
  s3: "#1c222b",
  border: "#262d36",
  fg: "#e6e9ef",
  fgMuted: "#8b93a1",
  fgDim: "#5b626f",
  yellow: "#e0b341",
  red: "#ef5d5d",
  /** The terminal well — darker than every panel surface so the screen reads
   *  as a terminal, not a card. */
  term: "#0a0c10",
  mono: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
} as const;

// ── the SSE lifecycle ────────────────────────────────────────────────────────
// "gone"/"unavailable" are TERMINAL (the server closes the stream after the
// event; we close the EventSource so its auto-reconnect doesn't hammer a dead
// session). A connect-time failure (the route's first-poll 404/503) surfaces as
// onerror BEFORE any open — also terminal. A post-open error is transient:
// EventSource auto-reconnects and the last screen stays painted.
type ScreenConn = "idle" | "connecting" | "open" | "gone" | "unavailable" | "error";

function useScreenStream(
  shortId: string | null,
  enabled: boolean,
): { view: ScreenViewState; conn: ScreenConn } {
  const [view, setView] = useState<ScreenViewState>({ screen: null, lastChangeAt: null });
  const [conn, setConn] = useState<ScreenConn>("idle");
  // Whether THIS EventSource ever connected — disambiguates the terminal
  // connect-time 404/503 from a transient mid-stream drop (kept in a ref so the
  // error handler never closes over stale state).
  const openedRef = useRef(false);

  useEffect(() => {
    // Reset whenever the session changes so one worker's screen never bleeds
    // into another's.
    setView({ screen: null, lastChangeAt: null });
    openedRef.current = false;
    if (!enabled || !shortId) {
      setConn("idle");
      return;
    }
    setConn("connecting");
    const es = new EventSource(`/api/ec-worker-screen/${encodeURIComponent(shortId)}`);
    // Catches both the native connect event and the server's `event: open`
    // greeting — either way the stream is live.
    es.addEventListener("open", () => {
      openedRef.current = true;
      setConn("open");
    });
    es.addEventListener("screen", (ev: MessageEvent<string>) => {
      const frame = parseScreenFrame(ev.data);
      if (frame) setView((prev) => applyScreenFrame(prev, frame, Date.now()));
    });
    es.addEventListener("gone", () => {
      setConn("gone");
      es.close(); // terminal — don't let auto-reconnect re-poll a dead session
    });
    es.addEventListener("unavailable", () => {
      setConn("unavailable");
      es.close(); // terminal — the claude CLI itself can't run
    });
    es.onerror = () => {
      if (!openedRef.current) {
        // Never connected: the route's first-poll guard said 404/503 — terminal.
        es.close();
        setConn("unavailable");
      } else {
        // Transient drop — EventSource auto-reconnects; keep the last screen.
        setConn("error");
      }
    };
    return () => es.close();
  }, [shortId, enabled]);

  return { view, conn };
}

// ── the pane ─────────────────────────────────────────────────────────────────

export function LiveScreenPane({
  bgJobId,
  transcriptLive,
}: {
  /** The worker's bg job id (signal bg_job_id) — short or full UUID. */
  bgJobId: string | null;
  /** true once the transcript live-tail has received rows — triggers the
   *  Scenario 3 hand-off (the pane collapses to standby). */
  transcriptLive: boolean;
}) {
  const shortId = shortIdFromBgJobId(bgJobId);
  const mode = deriveScreenPaneMode(shortId, transcriptLive);
  // After hand-off the operator can still re-open the screen (one click) —
  // e.g. a worker that wedges AGAIN mid-run on a dialog.
  const [showAnyway, setShowAnyway] = useState(false);
  const streaming = mode === "screen" || (mode === "handed-off" && showAnyway);
  const { view, conn } = useScreenStream(shortId, streaming);

  // 1s clock so "last change Xs ago" ticks while the page is open.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const status = deriveScreenStatus(view.lastChangeAt, now);

  return (
    <div
      data-worker-live-screen
      data-screen-mode={mode}
      data-screen-conn={conn}
      style={{ background: C.s2, border: `1px solid ${C.border}`, borderRadius: 8, padding: "10px 12px" }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: streaming ? 8 : 0 }}>
        <span
          style={{
            font: `10px ${C.mono}`,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: C.fgMuted,
          }}
        >
          Live Screen · claude logs
        </span>
        <span style={{ flex: 1 }} />
        {/* the wedge tell (Scenario 2): unchanged past ~10 polls → loud label */}
        {streaming && status.wedged && status.ageMs != null && (
          <span
            data-screen-wedged
            style={{ font: `10px ${C.mono}`, color: C.red, fontWeight: 600 }}
          >
            no output for {fmtScreenAge(status.ageMs)}
          </span>
        )}
        {/* "last change Xs ago" — derived from frame receipt, dims pre-frame */}
        {streaming && (
          <span
            data-screen-age
            style={{ font: `10px ${C.mono}`, color: status.ageMs == null ? C.fgDim : status.wedged ? C.yellow : C.fgMuted }}
          >
            {status.ageMs == null ? "no frame yet" : `last change ${fmtScreenAge(status.ageMs)} ago`}
          </span>
        )}
        {mode === "handed-off" && (
          <button
            type="button"
            data-screen-show-anyway
            aria-pressed={showAnyway}
            onClick={() => setShowAnyway((s) => !s)}
            style={{
              background: showAnyway ? C.s3 : "transparent",
              border: `1px solid ${C.border}`,
              borderRadius: 5,
              color: showAnyway ? LIVE_CYAN : C.fgMuted,
              cursor: "pointer",
              font: `10px ${C.mono}`,
              padding: "2px 8px",
            }}
          >
            {showAnyway ? "hide screen" : "show screen"}
          </button>
        )}
      </div>

      {mode === "no-id" ? (
        <div data-screen-no-id style={{ font: `11px ${C.mono}`, color: C.fgDim, padding: "6px 0 0" }}>
          bg_job_id not on the signal yet — screen unavailable ↯
        </div>
      ) : mode === "handed-off" && !showAnyway ? (
        <div data-screen-standby style={{ font: `11px ${C.mono}`, color: C.fgDim, padding: "6px 0 0" }}>
          transcript live-tail active — screen view on standby
        </div>
      ) : (
        <>
          {/* the terminal: dark well, monospace, the FULL rendered screen.
              The last screen stays painted through gone/error so the operator
              keeps the final evidence (exactly the wedge-diagnosis artifact). */}
          {view.screen != null ? (
            <pre
              data-screen-terminal
              style={{
                margin: 0,
                maxHeight: 420,
                overflow: "auto",
                background: C.term,
                border: `1px solid ${C.border}`,
                borderRadius: 6,
                padding: 10,
                font: `11px/1.45 ${C.mono}`,
                color: C.fg,
                whiteSpace: "pre",
              }}
            >
              {view.screen}
            </pre>
          ) : (
            <div data-screen-placeholder style={{ font: `11px ${C.mono}`, color: C.fgDim, padding: "6px 0" }}>
              {conn === "connecting"
                ? "connecting to screen…"
                : conn === "unavailable"
                  ? "screen unavailable — session gone or claude CLI absent"
                  : conn === "gone"
                    ? "session ended before a screen was captured"
                    : "waiting for the first screen frame…"}
            </div>
          )}
          {/* terminal-state footnotes once a screen HAS been painted */}
          {view.screen != null && conn === "gone" && (
            <div data-screen-gone style={{ font: `10px ${C.mono}`, color: C.fgDim, marginTop: 6 }}>
              session ended — final screen above
            </div>
          )}
          {view.screen != null && conn === "error" && (
            <div data-screen-retrying style={{ font: `10px ${C.mono}`, color: C.yellow, marginTop: 6 }}>
              stream interrupted — retrying…
            </div>
          )}
        </>
      )}
    </div>
  );
}
