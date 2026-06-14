// now-panel.tsx — the worker-detail v2 "Now / Live activity" panel (CTL-925 /
// WORKER-DETAIL v2 Pass A §3). THIS replaces the garbled LiveScreenPane: the
// /api/ec-worker-screen raw scrape strips ALL ANSI (incl. cursor-positioning), so
// spatially-placed text collapses to 1-char lines — the CONTENT is destroyed. We
// never ship that corrupted pane. Instead the Now panel is built ENTIRELY from the
// typed live transcript stream (StreamEvent via useLiveTail → parseStreamEvent):
//
//   • a large, readable "Now" HEADLINE — the current/most-recent action
//     (▶ tool · arg / ◌ thinking… / ↻ new turn / ✓ complete) + a liveness dot,
//   • a rolling ACTIVITY FEED (the existing LiveStreamRow renderer) — readable
//     rows, NOT a terminal, autoscroll-unless-scrolled-up, with the pause
//     affordance (pause freezes the VIEW; the stream keeps buffering),
//   • radix Tabs (Now · History) — the hand-rolled live/history tabs ported to the
//     shared tabs primitive; History is the existing Loki tail.
//
// A faithful raw terminal (un-stripped ANSI / xterm.js) is a documented FOLLOW-UP,
// NOT this PR — we drop the corrupted screen rather than ship it.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { C, CARD_LIFT } from "./board-tokens";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import type { StreamEvent } from "@/lib/types";
import {
  resolvePausedView,
  deriveFooterCounters,
  resolveLiveTerminalRows,
} from "./live-tail-data";
import {
  deriveNowHeadline,
  latestEvent,
  type NowHeadline,
} from "./worker-now-data";
import { deriveLiveness, type LivenessLevel } from "./worker-detail-data";
import { LIVE_CYAN } from "./detail-chrome";


const LIVENESS_COLOR: Record<LivenessLevel, string> = {
  green: C.green,
  yellow: C.yellow,
  red: C.red,
  unknown: C.fgDim,
};

const HEADLINE_GLYPH_COLOR: Record<NowHeadline["kind"], string> = {
  tool: "#4ea1ff",
  thinking: C.fgMuted,
  turn: LIVE_CYAN,
  result: C.green,
  retry: C.yellow,
  rate_limit: C.red,
  text: C.fg,
  none: C.fgDim,
};

function fmtTs(ts: number): string {
  const d = new Date(ts);
  return (
    String(d.getHours()).padStart(2, "0") +
    ":" +
    String(d.getMinutes()).padStart(2, "0") +
    ":" +
    String(d.getSeconds()).padStart(2, "0")
  );
}

function fmtIdleShort(ms: number | null): string {
  if (ms == null) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m${s % 60}s` : `${Math.floor(m / 60)}h${m % 60}m`;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}k`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

// ── the live stream row (ported from the old ActivityTail, inline-C skin) ─────
export function LiveStreamRow({ event }: { event: StreamEvent }) {
  const base = {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "2px 0",
    font: `11px ${C.mono}`,
  } as const;
  const dot = (color: string) => (
    <span style={{ width: 6, height: 6, borderRadius: "50%", background: color, flex: "0 0 auto" }} />
  );
  const tsCell = <span style={{ color: C.fgDim, flex: "0 0 auto" }}>{fmtTs(event.ts)}</span>;
  switch (event.type) {
    case "tool_start":
      return (
        <div data-live-row="tool_start" style={base}>
          {tsCell}
          {dot("#4ea1ff")}
          <span style={{ color: "#4ea1ff", flex: "0 0 auto" }}>{event.tool ?? "tool"}</span>
          {event.toolInput && (
            <span style={{ color: C.fgMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {event.toolInput.slice(0, 80)}
            </span>
          )}
        </div>
      );
    case "text":
      return (
        <div data-live-row="text" style={base}>
          {tsCell}
          {dot(C.green)}
          <span style={{ color: C.fg, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {event.text?.slice(0, 100) ?? "…"}
          </span>
        </div>
      );
    case "reasoning":
      return (
        <div data-live-row="reasoning" style={base}>
          {tsCell}
          <span style={{ color: C.fgMuted, flex: "0 0 auto" }}>◌</span>
          <span style={{ color: C.fgMuted, fontStyle: "italic", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {event.text?.slice(0, 100) ?? "thinking…"}
          </span>
        </div>
      );
    case "turn":
      return (
        <div data-live-row="turn" style={base}>
          {tsCell}
          {dot(LIVE_CYAN)}
          <span style={{ color: C.fg, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {event.turnTools && event.turnTools.length > 0
              ? event.turnTools.join(", ")
              : event.text
                ? event.text.slice(0, 100)
                : "new turn"}
          </span>
        </div>
      );
    case "retry":
      return (
        <div data-live-row="retry" style={base}>
          {tsCell}
          {dot(C.yellow)}
          <span style={{ color: C.yellow }}>
            retry {event.retryInfo?.attempt}/{event.retryInfo?.maxRetries}
          </span>
        </div>
      );
    case "rate_limit":
      return (
        <div data-live-row="rate_limit" style={base}>
          {tsCell}
          {dot(C.red)}
          <span style={{ color: C.red }}>rate limited</span>
        </div>
      );
    case "result":
      return (
        <div data-live-row="result" style={base}>
          {tsCell}
          {dot(C.green)}
          <span style={{ color: C.green, fontWeight: 600 }}>complete</span>
        </div>
      );
    default:
      return null;
  }
}

// ── the Now headline (the big "what it's doing" line) ────────────────────────
function NowHeadlineRow({
  buffer,
  conn,
  lastActiveMs,
  sessionId,
}: {
  buffer: StreamEvent[];
  conn: "idle" | "connecting" | "open" | "error";
  lastActiveMs: number | null;
  sessionId: string | null;
}) {
  // A 1s clock so the idle reading stays fresh.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const headline = useMemo(() => deriveNowHeadline(buffer), [buffer]);
  const liveness = deriveLiveness(lastActiveMs, now);

  // Honest degraded copy when there is no event to headline (never blank/fake).
  let primary: React.ReactNode;
  if (headline.kind === "none") {
    if (sessionId == null) {
      primary = <span style={{ color: C.fgDim }}>no session id — live unavailable</span>;
    } else if (conn === "connecting") {
      primary = <span style={{ color: C.fgMuted }}>connecting to the live stream…</span>;
    } else if (conn === "error") {
      primary = <span style={{ color: C.fgDim }}>stream momentarily unavailable</span>;
    } else {
      primary = <span style={{ color: C.fgDim }}>waiting for the next action…</span>;
    }
  } else {
    primary = (
      <span style={{ display: "inline-flex", alignItems: "baseline", gap: 8, minWidth: 0 }}>
        <span style={{ color: HEADLINE_GLYPH_COLOR[headline.kind], flex: "0 0 auto" }}>{headline.glyph}</span>
        <span style={{ color: C.fg, fontWeight: 600, flex: "0 0 auto" }}>{headline.label}</span>
        {headline.detail && (
          <span
            style={{ color: C.fgMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          >
            · {headline.detail}
          </span>
        )}
      </span>
    );
  }

  return (
    <div
      data-now-headline
      data-now-kind={headline.kind}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "10px 12px",
        background: C.s1,
        border: `1px solid ${C.border}`,
        borderRadius: 8,
        font: `14px ${C.mono}`,
        minWidth: 0,
      }}
    >
      <span style={{ flex: "1 1 auto", minWidth: 0, overflow: "hidden" }}>{primary}</span>
      <span
        data-now-liveness={liveness.level}
        style={{ display: "inline-flex", alignItems: "center", gap: 6, flex: "0 0 auto", font: `11px ${C.mono}`, color: C.fgMuted }}
      >
        <span style={{ width: 9, height: 9, borderRadius: "50%", background: LIVENESS_COLOR[liveness.level], display: "inline-block" }} />
        {fmtIdleShort(liveness.idleMs)} idle
      </span>
    </div>
  );
}

// ── the rolling activity feed (autoscroll-unless-scrolled-up) ────────────────
function ActivityFeed({ rows }: { rows: StreamEvent[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  // Track whether the operator is pinned to the bottom; only autoscroll then.
  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [rows]);

  return (
    <div
      ref={ref}
      onScroll={onScroll}
      data-now-feed
      style={{ maxHeight: 320, overflow: "auto" }}
    >
      {rows.map((r, i) => (
        <LiveStreamRow key={`${r.ts}-${i}`} event={r} />
      ))}
    </div>
  );
}

// ── the Now tab body (headline + feed + footer + pause) ──────────────────────
function NowTab({
  buffer,
  conn,
  sessionId,
  lastActiveMs,
}: {
  buffer: StreamEvent[];
  conn: "idle" | "connecting" | "open" | "error";
  sessionId: string | null;
  lastActiveMs: number | null;
}) {
  const [paused, setPaused] = useState(false);
  const frozenLenRef = useRef(0);

  const visible = resolvePausedView(buffer, paused, frozenLenRef.current);
  const footer = useMemo(() => deriveFooterCounters(buffer), [buffer]);

  const togglePause = useCallback(() => {
    setPaused((p) => {
      if (!p) frozenLenRef.current = buffer.length;
      return !p;
    });
  }, [buffer.length]);

  // Never-blank: the single derived MVP row when the buffer is empty.
  const latest = latestEvent(buffer);
  const terminal = resolveLiveTerminalRows(
    visible.rows,
    latest?.type === "tool_start" ? (latest.tool ?? null) : null,
    null,
    Date.now(),
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <NowHeadlineRow buffer={buffer} conn={conn} lastActiveMs={lastActiveMs} sessionId={sessionId} />

      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ font: `10px ${C.mono}`, letterSpacing: "0.08em", textTransform: "uppercase", color: C.fgMuted }}>
          Live activity
        </span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          data-now-pause
          aria-pressed={paused}
          onClick={togglePause}
          title={paused ? "resume — replays the buffered gap" : "pause — freezes the view; the stream keeps buffering"}
          style={{ background: paused ? C.s3 : "transparent", border: `1px solid ${C.border}`, borderRadius: 5, color: paused ? LIVE_CYAN : C.fgMuted, cursor: "pointer", font: `10px ${C.mono}`, padding: "2px 8px" }}
        >
          {paused ? "▶ resume" : "⏸ pause"}
        </button>
      </div>

      {sessionId == null ? (
        <div data-now-empty style={{ font: `11px ${C.mono}`, color: C.fgDim, padding: "8px 0" }}>
          no session id — live activity unavailable for this run
        </div>
      ) : terminal.source === "empty" ? (
        <div data-now-placeholder style={{ font: `11px ${C.mono}`, color: C.fgDim, padding: "8px 0" }}>
          {conn === "connecting" ? "connecting to the live stream…" : "stream momentarily unavailable"}
        </div>
      ) : (
        <ActivityFeed rows={terminal.rows} />
      )}

      <div data-now-footer style={{ display: "flex", alignItems: "center", gap: 10, font: `10px ${C.mono}`, color: C.fgMuted }}>
        <span data-footer-events>{footer.events} events</span>
        <span style={{ color: C.fgDim }}>·</span>
        <span data-footer-tools>{footer.tools} tools</span>
        <span style={{ color: C.fgDim }}>·</span>
        <span data-footer-retries>{footer.retries} retr{footer.retries === 1 ? "y" : "ies"}</span>
        <span style={{ color: C.fgDim }}>·</span>
        <span data-footer-stream>stream {fmtBytes(footer.streamBytes)}</span>
        {paused && (
          <>
            <span style={{ flex: 1 }} />
            <span data-footer-buffered style={{ color: LIVE_CYAN }}>
              ⏸ {visible.bufferedWhilePaused} buffered
            </span>
          </>
        )}
      </div>
    </div>
  );
}

// ── the Now panel (Tabs: Now · History) ──────────────────────────────────────
export function NowPanel({
  sessionId,
  alive,
  lastActiveMs,
  buffer,
  conn,
  history,
}: {
  sessionId: string | null;
  alive: boolean;
  lastActiveMs: number | null;
  /** The live StreamEvent buffer (from the hoisted useWorkerDetailModel). */
  buffer: StreamEvent[];
  conn: "idle" | "connecting" | "open" | "error";
  /** The History tab body — the existing Loki tail, rendered by the body so this
   *  panel stays purely the structured-stream surface. */
  history: React.ReactNode;
}) {
  // CONTROLLED tab selection: the resident `worker` (hence `alive`) arrives async
  // off the board stream, so a defaultValue computed at FIRST mount lands a live
  // worker on History (alive was still false). We track the operator's EXPLICIT
  // pick; until they choose, the tab follows `alive` (live → Now, dead → History)
  // as the payload resolves. Once picked, the choice sticks.
  const [picked, setPicked] = useState<"now" | "history" | null>(null);
  const value = picked ?? (alive ? "now" : "history");

  return (
    <div
      data-now-panel
      data-active-tab={value}
      style={{ background: C.s2, border: `1px solid ${C.border}`, borderRadius: 8, padding: "10px 12px", boxShadow: CARD_LIFT }}
    >
      <Tabs value={value} onValueChange={(v) => setPicked(v === "history" ? "history" : "now")}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <span style={{ font: `10px ${C.mono}`, letterSpacing: "0.08em", textTransform: "uppercase", color: C.fgMuted }}>
            Now
          </span>
          <span style={{ flex: 1 }} />
          <TabsList className="h-7">
            <TabsTrigger value="now" className="text-[11px] px-2">
              <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: alive ? LIVE_CYAN : C.fgDim, display: "inline-block" }} />
                now
              </span>
            </TabsTrigger>
            <TabsTrigger value="history" className="text-[11px] px-2">
              history
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="now">
          <NowTab buffer={buffer} conn={conn} sessionId={sessionId} lastActiveMs={lastActiveMs} />
        </TabsContent>
        <TabsContent value="history">{history}</TabsContent>
      </Tabs>
    </div>
  );
}
