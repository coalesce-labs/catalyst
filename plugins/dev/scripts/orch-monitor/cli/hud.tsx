#!/usr/bin/env bun
import { useState, useCallback, useEffect, useRef } from "react";
import { render, useApp, useInput, Box, Text } from "ink";
import { Header } from "./components/Header.tsx";
import { readBrokerState, type BrokerState } from "./lib/broker-key-health.ts";
import { EventList } from "./components/EventList.tsx";
import { FilterInput } from "./components/FilterInput.tsx";
import { QueryInput } from "./components/QueryInput.tsx";
import { DetailPane, buildDetailLines } from "./components/DetailPane.tsx";
import {
  computeBottomOverlaySize,
  computeDetailLayout,
  reanchorListScrollOffset,
} from "./lib/detail-layout.ts";
import { useEventLog } from "./hooks/useEventLog.ts";
import { useFilter, type DslPredicate } from "./hooks/useFilter.ts";
import { useSelection } from "./hooks/useSelection.ts";
import { decidePivotAction } from "./lib/pivot-decision.ts";
import { detectNerdFont } from "./lib/nerd-font.ts";
import { parseSinceSpec } from "./lib/since-spec.ts";
import {
  compile,
  groqTranslate,
  rewriteNode,
  readGroqApiKeyFromConfig,
  DslError,
  GroqHttpError,
  GroqResponseError,
} from "../../lib/dsl-compile.mjs";
import { buildSystemPrompt } from "../../lib/dsl-prompt.mjs";
import type { CanonicalEvent } from "../lib/canonical-event.ts";

interface AppProps {
  repoFilter: string;
  predicate: string;
  sinceTs: string;
}

interface DslState {
  dsl: object;
  jsPredicate: (event: CanonicalEvent) => boolean;
  nlQuery: string;
}

const HELP_LINES = [
  "Navigation",
  "  j / ↓           next event         k / ↑         prev event",
  "  PgDn             page down          PgUp          page up",
  "  G                jump to newest (resume live tail)",
  "",
  "Detail pane  (Enter to open/close)",
  "  j / k            scroll content     Esc           close",
  "  n / p            next / prev event  (stays in detail — no need to close)",
  "",
  "Filters",
  "  /                substring filter — applies to all loaded events",
  "  :                natural-language query via Groq (needs GROQ_API_KEY)",
  "  :since 24h       reload events from last 24 h  (also: 7d, 2h, 30m, ISO date)",
  "  ?                show generated DSL and active :since window",
  "  Esc              clear all filters (:since, /, :query) / close overlay",
  "",
  "Scope — narrow to related events  (live mode: first press pauses; press again to apply)",
  "  t                scope to all events sharing this event's trace ID",
  "  o                scope to all events from this event's orchestrator",
  "  r                reset scope (show all events)",
  "",
  "  h                this help          q / Ctrl-C    quit",
];

function App({ repoFilter, predicate, sinceTs: initSinceTs }: AppProps) {
  const { exit } = useApp();

  // Enter the alternate screen buffer after Ink initializes. Writing it before
  // render() doesn't work because Ink's setup sequence resets terminal state.
  // We enter here (post-mount), clear the screen, then emit a resize so Ink
  // repaints the entire layout from (0,0) — making the header always visible.
  useEffect(() => {
    process.stdout.write("\x1b[?1049h\x1b[2J\x1b[H");
    const onExit = () => { process.stdout.write("\x1b[?1049l"); };
    process.on("exit", onExit);
    // Let Ink settle, then force a full repaint onto the clean alternate screen.
    const t = setTimeout(() => process.stdout.emit("resize"), 50);
    return () => {
      clearTimeout(t);
      process.off("exit", onExit);
      process.stdout.write("\x1b[?1049l");
    };
  }, []);

  // Track terminal dimensions as state so resize triggers re-renders.
  const [rows, setRows] = useState(() => process.stdout.rows ?? 40);
  const [cols, setCols] = useState(() => process.stdout.columns ?? 120);
  const firstRender = useRef(true);
  useEffect(() => {
    const update = () => {
      setRows(process.stdout.rows ?? 40);
      setCols(process.stdout.columns ?? 120);
    };
    process.stdout.on("resize", update);
    process.on("SIGWINCH", update);
    return () => {
      process.stdout.off("resize", update);
      process.off("SIGWINCH", update);
    };
  }, []);
  // After our state settles, tell Ink to do a full clear+redraw. Skip first mount.
  useEffect(() => {
    if (firstRender.current) { firstRender.current = false; return; }
    process.stdout.emit("resize");
  }, [rows, cols]);

  // Warp split panes render their title bar inside the pty, so process.stdout.rows
  // is 1-2 rows larger than the visible area. Subtract 2 as a safe margin.
  const layoutRows = Math.max(10, rows - 2);

  // Interactive since — can be changed via `:since 24h` without restarting.
  // CTL-387: `activeSinceLabel` is the human-readable spec the user typed
  // (e.g. "5m") for the footer chip + `?` overlay. It is `null` until the
  // user submits a `:since` interactively, and reverts to `null` on ESC so
  // the chip disappears when the window matches HUD startup.
  const [activeSinceTs, setActiveSinceTs] = useState(initSinceTs);
  const [activeSinceLabel, setActiveSinceLabel] = useState<string | null>(null);

  const { events, loading } = useEventLog({ repoFilter, predicate, sinceTs: activeSinceTs });

  // CTL-343 / CTL-352: broker state chip(s). Poll broker.state.json every 5s
  // so the chips surface fresh probe results AND interest-count updates
  // without busy-reading on every render.
  const [brokerState, setBrokerState] = useState<BrokerState | null>(null);
  useEffect(() => {
    const refresh = () => setBrokerState(readBrokerState());
    refresh();
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, []);

  const [dslState, setDslState] = useState<DslState | null>(null);
  const dslPredicate: DslPredicate = dslState?.jsPredicate ?? null;
  const { filterText, setFilterText, pivot, setPivot, filtered } = useFilter(events, dslPredicate);

  // Header = optional chip row (0/1) + column row (1) + separator (1) + optional nlQuery row (0/1)
  // CTL-352: chip row is shown whenever Groq or broker-interest data is available.
  const hasChipRow = Boolean(brokerState?.groq) || typeof brokerState?.interestCount === "number";
  const headerRows = (hasChipRow ? 1 : 0) + (dslState?.nlQuery ? 3 : 2);

  const [showDslOverlay, setShowDslOverlay] = useState(false);
  const [dslScrollTop, setDslScrollTop] = useState(0);
  // CTL-387: overlay shows when either a DSL is set or a since spec is active.
  const overlayHasContent = Boolean(dslState) || Boolean(activeSinceLabel);
  const overlayHeight = showDslOverlay && overlayHasContent ? Math.min(14, Math.floor(layoutRows / 2)) : 0;

  const [showHelp, setShowHelp] = useState(false);

  // chrome = header + separator(1) + filter(1) + query(1) + dsl overlay (if any).
  // CTL-363: the standalone status row was folded into FilterInput and a `─`
  // separator now sits above the footer, mirroring Header.tsx's top separator.
  // Help and detail are bottom-anchored *inside* visibleRows via the layout
  // helpers below — they no longer steal rows from the top.
  const chromeRows = headerRows + 3 + overlayHeight;
  const visibleRows = Math.max(1, layoutRows - chromeRows);

  const {
    selectedIndex,
    scrollOffset,
    moveUp,
    moveDown,
    pageUp,
    pageDown,
    jumpToBottom,
    pauseAutoFollow,
    autoFollow,
  } = useSelection(filtered.length, visibleRows);

  const [filterFocused, setFilterFocused] = useState(false);
  const [queryFocused, setQueryFocused] = useState(false);
  const [queryText, setQueryText] = useState("");
  const [queryError, setQueryError] = useState<string | null>(null);
  const [querySubmitting, setQuerySubmitting] = useState(false);

  const [showDetail, setShowDetail] = useState(false);
  const [detailScrollTop, setDetailScrollTop] = useState(0);

  // Brief transient status message (cleared after 3s)
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const statusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showStatus = (msg: string) => {
    if (statusTimer.current) clearTimeout(statusTimer.current);
    setStatusMsg(msg);
    statusTimer.current = setTimeout(() => setStatusMsg(null), 3000);
  };

  useEffect(() => {
    setDetailScrollTop(0);
  }, [selectedIndex]);

  useEffect(() => {
    if (showDslOverlay) setDslScrollTop(0);
  }, [showDslOverlay]);

  const selectedEvent = filtered[selectedIndex] ?? null;

  // Help and detail are mutually exclusive bottom-anchored overlays. Help wins
  // when both states would be true (opening help already swallows all input,
  // so a simultaneously rendered detail pane would be dead state).
  // Each overlay sits flush against the status row and the event list fills
  // all remaining height above it (CTL-324, CTL-325). Layout math is
  // extracted into pure helpers for testability.
  const inDetailMode = showDetail && !!selectedEvent && !showHelp;
  const detailLines = selectedEvent ? buildDetailLines(selectedEvent, cols) : [];

  let listRows: number;
  let listScrollOffset: number;
  let detailContentRows = 0;
  // Visible content rows inside the help panel (excludes the 2 borders and the
  // 1-row title). 0 when help is closed.
  let helpVisibleRows = 0;

  if (showHelp) {
    // Natural height = HELP_LINES + title row + 2 borders.
    const natural = HELP_LINES.length + 1 + 2;
    const size = computeBottomOverlaySize(visibleRows, natural);
    helpVisibleRows = Math.max(1, size.paneRows - 3);
    listRows = size.listRows;
    listScrollOffset = reanchorListScrollOffset(
      selectedIndex,
      filtered.length,
      listRows,
      scrollOffset,
    );
  } else {
    const detail = computeDetailLayout({
      visibleRows,
      inDetailMode,
      detailLineCount: detailLines.length,
      selectedIndex,
      totalEvents: filtered.length,
      currentScrollOffset: scrollOffset,
    });
    detailContentRows = detail.detailContentRows;
    listRows = detail.listRows;
    listScrollOffset = detail.listScrollOffset;
  }

  const dslLines = dslState ? JSON.stringify(dslState.dsl, null, 2).split("\n") : [];
  const dslVisibleLines = Math.max(1, overlayHeight - 2);
  const maxDslScroll = Math.max(0, dslLines.length - dslVisibleLines);

  // title row is sticky in DetailPane, so scrollable = detailLines minus the title
  const maxDetailScroll = Math.max(0, (detailLines.length - 1) - detailContentRows);

  const submitQuery = useCallback(async (raw: string) => {
    const text = raw.trim();
    if (!text) return;
    setQuerySubmitting(true);
    setQueryError(null);

    // :since <spec> — reload events from a different point in time
    const sinceMatch = text.match(/^since\s+(.+)/i);
    if (sinceMatch) {
      const spec = (sinceMatch[1] ?? "").trim();
      const parsed = parseSinceSpec(spec);
      if (parsed) {
        setActiveSinceTs(parsed);
        setActiveSinceLabel(spec);
        setQueryFocused(false);
        setQueryText("");
        showStatus(`reloaded from ${spec}`);
      } else {
        setQueryError(`can't parse "${spec}" — try "24h", "7d", "2h", "30m", or an ISO date`);
      }
      setQuerySubmitting(false);
      return;
    }

    try {
      const apiKey = process.env["GROQ_API_KEY"] || readGroqApiKeyFromConfig();
      // CTL-365: inject current time per-request so "last 24 hours" etc. resolve
      // against the wall clock rather than silently degrading to UTC midnight.
      const systemPrompt = buildSystemPrompt({ now: new Date() });
      const dsl = await groqTranslate(text, { apiKey, systemPrompt });
      const rewritten = { ...dsl, filter: dsl.filter ? rewriteNode(dsl.filter) : {} };
      const compiled = compile(rewritten);
      setDslState({ dsl: rewritten, jsPredicate: compiled.jsPredicate, nlQuery: text });
      setQueryFocused(false);
      setQueryText("");
    } catch (err) {
      let msg = "unknown error";
      if (err instanceof DslError) {
        msg = err.suggestion ? `${err.message} (did you mean ${err.suggestion}?)` : err.message;
      } else if (err instanceof GroqHttpError) {
        msg = `Groq HTTP ${err.status}: ${err.message}`;
      } else if (err instanceof GroqResponseError) {
        msg = `Groq response: ${err.message}`;
      } else if (err instanceof Error) {
        msg = err.message;
      }
      setQueryError(msg);
    } finally {
      setQuerySubmitting(false);
    }
  }, []);

  useInput((input, key) => {
    if (queryFocused) {
      if (key.escape) { setQueryFocused(false); setQueryText(""); setQueryError(null); }
      return;
    }
    if (filterFocused) {
      if (key.escape) { setFilterFocused(false); setFilterText(""); setPivot(null); }
      return;
    }

    if (key.escape) {
      if (showHelp) { setShowHelp(false); return; }
      if (showDetail) { setShowDetail(false); return; }
      if (showDslOverlay) { setShowDslOverlay(false); return; }
      setPivot(null);
      setFilterText("");
      setDslState(null);
      setQueryError(null);
      // CTL-387: ESC is a full reset — revert :since to the HUD-startup value
      // so the time window matches what the user launched with.
      setActiveSinceTs(initSinceTs);
      setActiveSinceLabel(null);
      return;
    }
    if (input === "q" || (key.ctrl && input === "c")) { exit(); return; }

    if (showHelp) {
      if (input === "h") { setShowHelp(false); return; }
      return; // swallow all keys while help is open
    }

    if (showDslOverlay) {
      if (input === "j" || key.downArrow) { setDslScrollTop((t) => Math.min(maxDslScroll, t + 1)); return; }
      if (input === "k" || key.upArrow) { setDslScrollTop((t) => Math.max(0, t - 1)); return; }
    }
    if (showDetail && !showDslOverlay) {
      if (input === "j" || key.downArrow) { setDetailScrollTop((t) => Math.min(maxDetailScroll, t + 1)); return; }
      if (input === "k" || key.upArrow) { setDetailScrollTop((t) => Math.max(0, t - 1)); return; }
      // n/p: move to next/prev event without closing the detail pane (Gmail-style)
      if (input === "n") { moveDown(); setDetailScrollTop(0); return; }
      if (input === "p") { moveUp(); setDetailScrollTop(0); return; }
    }

    if (input === "j" || key.downArrow) { moveDown(); return; }
    if (input === "k" || key.upArrow) { moveUp(); return; }
    if (key.pageDown) { pageDown(); return; }
    if (key.pageUp) { pageUp(); return; }
    if (input === "G") { jumpToBottom(); return; }
    if (input === "/") { setFilterFocused(true); return; }
    if (input === ":") { setQueryFocused(true); setQueryError(null); return; }
    if (input === "h") { setShowHelp(true); return; }
    if (input === "?" && overlayHasContent) { setShowDslOverlay((v) => !v); return; }
    if (key.return) { setShowDetail((v) => !v); return; }
    if (input === "o" || input === "t") {
      const action = decidePivotAction({ key: input, autoFollow, selectedEvent });
      if (action.kind === "pause") {
        pauseAutoFollow();
      } else if (action.kind === "pivot") {
        setPivot(action.pivot);
      }
      showStatus(action.status);
      return;
    }
    if (input === "r") {
      setPivot(null);
      showStatus("scope cleared");
      return;
    }
  });

  if (loading) {
    return <Text>Loading events…</Text>;
  }

  return (
    <Box flexDirection="column" height={layoutRows} width={cols}>
      <Box flexShrink={0}>
        <Header columns={cols} nlQuery={dslState?.nlQuery} brokerState={brokerState} />
      </Box>
      <Box flexDirection="column" flexGrow={(inDetailMode || showHelp) ? 0 : 1} flexShrink={1}>
        <EventList
          events={filtered}
          selectedIndex={selectedIndex}
          scrollOffset={listScrollOffset}
          visibleRows={listRows}
          columns={cols}
          compact={inDetailMode || showHelp}
          paused={!autoFollow}
        />
      </Box>
      {inDetailMode && selectedEvent && (
        <Box flexShrink={0}>
          <DetailPane
            event={selectedEvent}
            scrollTop={detailScrollTop}
            maxHeight={detailContentRows}
          />
        </Box>
      )}
      {showHelp && (
        <Box flexShrink={0} flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
          <Text color="cyan" bold>{"Keybindings — h or Esc to close"}</Text>
          {HELP_LINES.slice(0, helpVisibleRows).map((line, i) => (
            <Text key={i} dimColor={!line.startsWith("  ")}>{line || " "}</Text>
          ))}
        </Box>
      )}
      {showDslOverlay && overlayHasContent && (
        <Box flexShrink={0} flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
          <Text color="magenta" bold>{
            dslState
              ? `Query overlay · j/k scroll · ? to hide (${dslScrollTop + 1}/${dslLines.length}):`
              : "Query overlay · ? to hide:"
          }</Text>
          {activeSinceLabel && (
            <Text>{`Time window: ${activeSinceLabel} (since ${activeSinceTs})`}</Text>
          )}
          {dslState && dslLines.slice(dslScrollTop, dslScrollTop + dslVisibleLines).map((line, i) => (
            <Text key={i} dimColor={i > 0}>{line}</Text>
          ))}
        </Box>
      )}
      <Box flexShrink={0}>
        <Text dimColor>{"─".repeat(Math.max(0, cols - 1))}</Text>
      </Box>
      <Box flexShrink={0}>
        <FilterInput
          value={filterText}
          focused={filterFocused}
          onChange={setFilterText}
          pivot={pivot}
          cols={cols}
          filteredCount={filtered.length}
          totalCount={events.length}
          autoFollow={autoFollow}
          statusMsg={statusMsg}
          activeSinceLabel={activeSinceLabel}
        />
      </Box>
      <Box flexShrink={0}>
        <QueryInput
          value={queryText}
          focused={queryFocused}
          busy={querySubmitting}
          error={queryError}
          hasDsl={dslState !== null}
          cols={cols}
          onChange={setQueryText}
          onSubmit={(v) => { void submitQuery(v); }}
        />
      </Box>
    </Box>
  );
}

// CLI arg parsing
const args = process.argv.slice(2);
let repoFilter = "";
let predicate = "";
let sinceTs = "";

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  const next = args[i + 1];
  if ((arg === "--repo" || arg === "-r") && next) {
    repoFilter = next;
    i++;
  } else if (arg === "--filter" && next) {
    predicate = next;
    i++;
  } else if (arg === "--since" && next) {
    i++;
    const parsed = parseSinceSpec(next);
    sinceTs = parsed ?? next;
  } else if (arg === "--since-line") {
    i++;
  } else if (arg === "--help" || arg === "-h") {
    console.info("Usage: catalyst-hud [--repo PATTERN] [--since TIME] [--filter JQ]");
    console.info("");
    console.info("Press h inside the HUD for interactive keybinding help.");
    console.info("TIME examples: 24h  7d  2h  30m  2026-05-01");
    process.exit(0);
  }
}

if (!process.stdin.isTTY) {
  process.stderr.write(
    "catalyst-hud requires an interactive terminal.\n" +
    "Open a fresh terminal tab and run catalyst-hud there.\n",
  );
  process.exit(1);
}

// CTL-353: log Nerd Font detection so the user knows whether they're seeing
// the upgraded single-cell PUA in-progress glyph or the ellipsis fallback.
// Writes to stderr before Ink's alternate-screen takes over — visible in the
// parent shell's scrollback after the HUD exits.
const nerd = detectNerdFont();
if (nerd.detected) {
  process.stderr.write(`catalyst-hud: nerdfont detected (${nerd.source}: ${nerd.hint})\n`);
} else {
  process.stderr.write(`catalyst-hud: nerdfont ${nerd.hint}\n`);
}

render(<App repoFilter={repoFilter} predicate={predicate} sinceTs={sinceTs} />);
