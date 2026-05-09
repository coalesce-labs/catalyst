#!/usr/bin/env bun
import { useState, useCallback, useEffect } from "react";
import { render, useApp, useInput, Box, Text } from "ink";
import { Header } from "./components/Header.tsx";
import { EventList } from "./components/EventList.tsx";
import { FilterInput } from "./components/FilterInput.tsx";
import { QueryInput } from "./components/QueryInput.tsx";
import { DetailPane, buildDetailLines } from "./components/DetailPane.tsx";
import { useEventLog } from "./hooks/useEventLog.ts";
import { useFilter, type DslPredicate } from "./hooks/useFilter.ts";
import { useSelection } from "./hooks/useSelection.ts";
import {
  compile,
  groqTranslate,
  rewriteNode,
  readGroqApiKeyFromConfig,
  DslError,
  GroqHttpError,
  GroqResponseError,
} from "../../lib/dsl-compile.mjs";
import { SYSTEM_PROMPT } from "../../lib/dsl-prompt.mjs";
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

function App({ repoFilter, predicate, sinceTs }: AppProps) {
  const { exit } = useApp();

  // Track terminal dimensions as state so SIGWINCH + pane resizes trigger re-renders.
  // We listen to both process.stdout 'resize' (most terminals) and SIGWINCH (Warp split panes).
  const [rows, setRows] = useState(() => process.stdout.rows ?? 40);
  const [cols, setCols] = useState(() => process.stdout.columns ?? 120);
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

  const { events, loading } = useEventLog({ repoFilter, predicate, sinceTs });

  const [dslState, setDslState] = useState<DslState | null>(null);
  const dslPredicate: DslPredicate = dslState?.jsPredicate ?? null;
  const { filterText, setFilterText, pivot, setPivot, filtered } = useFilter(events, dslPredicate);

  // Header = column row (1) + separator (1) + optional nlQuery row (0 or 1)
  const headerRows = dslState?.nlQuery ? 3 : 2;

  // DSL overlay takes up a portion of the screen when open
  const [showDslOverlay, setShowDslOverlay] = useState(false);
  const [dslScrollTop, setDslScrollTop] = useState(0);
  const overlayHeight = showDslOverlay && dslState ? Math.min(14, Math.floor(rows / 2)) : 0;

  // chrome = header + status(1) + filter(1) + query(1) + overlay
  const chromeRows = headerRows + 3 + overlayHeight;
  const visibleRows = Math.max(1, rows - chromeRows);

  const { selectedIndex, scrollOffset, moveUp, moveDown, pageUp, pageDown, jumpToBottom, autoFollow } =
    useSelection(filtered.length, visibleRows);

  const [filterFocused, setFilterFocused] = useState(false);
  const [queryFocused, setQueryFocused] = useState(false);
  const [queryText, setQueryText] = useState("");
  const [queryError, setQueryError] = useState<string | null>(null);
  const [querySubmitting, setQuerySubmitting] = useState(false);

  const [showDetail, setShowDetail] = useState(false);
  const [detailScrollTop, setDetailScrollTop] = useState(0);

  // Reset detail scroll position whenever detail opens
  useEffect(() => {
    if (showDetail) setDetailScrollTop(0);
  }, [showDetail]);

  // Reset DSL scroll when overlay opens
  useEffect(() => {
    if (showDslOverlay) setDslScrollTop(0);
  }, [showDslOverlay]);

  const selectedEvent = filtered[selectedIndex] ?? null;

  // Detail pane height budget: border (2) + scroll indicator (1) = 3 overhead
  const detailPaneRows = showDetail && selectedEvent ? Math.min(18, Math.floor(rows / 3) + 1) : 0;
  const detailContentRows = Math.max(1, detailPaneRows - 3);
  const listRows = Math.max(1, visibleRows - detailPaneRows);

  // DSL overlay scroll bounds
  const dslLines = dslState ? JSON.stringify(dslState.dsl, null, 2).split("\n") : [];
  const dslVisibleLines = Math.max(1, overlayHeight - 2); // border overhead
  const maxDslScroll = Math.max(0, dslLines.length - dslVisibleLines);

  // Detail pane scroll bounds
  const detailLines = selectedEvent ? buildDetailLines(selectedEvent, cols) : [];
  const maxDetailScroll = Math.max(0, detailLines.length - detailContentRows);

  const submitQuery = useCallback(async (raw: string) => {
    const text = raw.trim();
    if (!text) return;
    setQuerySubmitting(true);
    setQueryError(null);
    try {
      const apiKey = process.env["GROQ_API_KEY"] || readGroqApiKeyFromConfig();
      const dsl = await groqTranslate(text, { apiKey, systemPrompt: SYSTEM_PROMPT });
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
      if (showDetail) { setShowDetail(false); return; }
      if (showDslOverlay) { setShowDslOverlay(false); return; }
      setPivot(null);
      setFilterText("");
      setDslState(null);
      setQueryError(null);
      return;
    }
    if (input === "q" || (key.ctrl && input === "c")) { exit(); return; }

    // Panel scroll takes priority over list navigation
    if (showDslOverlay) {
      if (input === "j" || key.downArrow) {
        setDslScrollTop((t) => Math.min(maxDslScroll, t + 1));
        return;
      }
      if (input === "k" || key.upArrow) {
        setDslScrollTop((t) => Math.max(0, t - 1));
        return;
      }
    }
    if (showDetail && !showDslOverlay) {
      if (input === "j" || key.downArrow) {
        setDetailScrollTop((t) => Math.min(maxDetailScroll, t + 1));
        return;
      }
      if (input === "k" || key.upArrow) {
        setDetailScrollTop((t) => Math.max(0, t - 1));
        return;
      }
    }

    // List navigation
    if (input === "j" || key.downArrow) { moveDown(); return; }
    if (input === "k" || key.upArrow) { moveUp(); return; }
    if (key.pageDown) { pageDown(); return; }
    if (key.pageUp) { pageUp(); return; }
    if (input === "G") { jumpToBottom(); return; }
    if (input === "/") { setFilterFocused(true); return; }
    if (input === ":") { setQueryFocused(true); setQueryError(null); return; }
    if (input === "?" && dslState) { setShowDslOverlay((v) => !v); return; }
    if (key.return) { setShowDetail((v) => !v); return; }
    if (input === "t" && selectedEvent?.traceId) {
      setPivot({ type: "trace", id: selectedEvent.traceId });
      return;
    }
    if (input === "o") {
      const orchId = selectedEvent?.attributes["catalyst.orchestrator.id"];
      if (orchId) setPivot({ type: "orch", id: orchId });
      return;
    }
    if (input === "r") { setPivot(null); return; }
  });

  if (loading) {
    return <Text>Loading events…</Text>;
  }

  return (
    <Box flexDirection="column">
      <Header columns={cols} nlQuery={dslState?.nlQuery} />
      <EventList
        events={filtered}
        selectedIndex={selectedIndex}
        scrollOffset={scrollOffset}
        visibleRows={listRows}
        columns={cols}
      />
      {showDetail && selectedEvent && (
        <DetailPane
          event={selectedEvent}
          scrollTop={detailScrollTop}
          maxHeight={detailContentRows}
        />
      )}
      <Box flexDirection="row">
        <Text dimColor>{`  ${filtered.length}/${events.length} events`}</Text>
        {autoFollow
          ? <Text color="green">{"  [LIVE]"}</Text>
          : <Text dimColor>{"  [PAUSED — G to follow]"}</Text>
        }
        {pivot && <Text color="cyan">{`  [${pivot.type} pivot — r reset]`}</Text>}
      </Box>
      {showDslOverlay && dslState && (
        <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
          <Text color="magenta" bold>{`Generated DSL · j/k scroll · ? to hide (${dslScrollTop + 1}/${dslLines.length}):`}</Text>
          {dslLines.slice(dslScrollTop, dslScrollTop + dslVisibleLines).map((line, i) => (
            <Text key={i} dimColor={i > 0}>{line}</Text>
          ))}
        </Box>
      )}
      <FilterInput
        value={filterText}
        focused={filterFocused}
        onChange={setFilterText}
        pivot={pivot}
      />
      <QueryInput
        value={queryText}
        focused={queryFocused}
        busy={querySubmitting}
        error={queryError}
        hasDsl={dslState !== null}
        onChange={setQueryText}
        onSubmit={(v) => { void submitQuery(v); }}
      />
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
    const raw = next;
    const match = raw.match(/^(\d+)\s*(h|m|s|hour|min|minute|second)s?$/i);
    if (match) {
      const n = parseInt(match[1] ?? "0", 10);
      const unit = (match[2] ?? "s").toLowerCase();
      const ms = unit.startsWith("h") ? n * 3600000 : unit.startsWith("m") ? n * 60000 : n * 1000;
      sinceTs = new Date(Date.now() - ms).toISOString();
    } else {
      sinceTs = raw;
    }
  } else if (arg === "--since-line") {
    i++;
  } else if (arg === "--help" || arg === "-h") {
    console.info("Usage: catalyst-hud [--repo PATTERN] [--since TIME] [--filter JQ]");
    console.info("");
    console.info("Keybindings:");
    console.info("  ↑/↓ or j/k   move selection (scroll detail/DSL when pane open)");
    console.info("  PgUp/PgDn    page through history");
    console.info("  Enter        toggle detail pane");
    console.info("  G            jump to newest event (resume live tail)");
    console.info("  /            focus substring filter");
    console.info("  :            focus natural-language query (Groq)");
    console.info("  ?            toggle generated DSL overlay");
    console.info("  Esc          close pane / clear filter / drop DSL filter");
    console.info("  t            pivot to selected event's traceId");
    console.info("  o            pivot to selected event's orchestratorId");
    console.info("  r            clear pivot");
    console.info("  q            quit");
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

render(<App repoFilter={repoFilter} predicate={predicate} sinceTs={sinceTs} />);
