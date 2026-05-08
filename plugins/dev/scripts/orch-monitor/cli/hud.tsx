#!/usr/bin/env bun
import { useState } from "react";
import { render, useApp, useInput, useStdin, useStdout, Box, Text } from "ink";
import { Header } from "./components/Header.tsx";
import { EventList } from "./components/EventList.tsx";
import { FilterInput } from "./components/FilterInput.tsx";
import { DetailPane } from "./components/DetailPane.tsx";
import { useEventLog } from "./hooks/useEventLog.ts";
import { useFilter } from "./hooks/useFilter.ts";
import { useSelection } from "./hooks/useSelection.ts";

interface AppProps {
  repoFilter: string;
  predicate: string;
  sinceTs: string;
}

function App({ repoFilter, predicate, sinceTs }: AppProps) {
  const { exit } = useApp();
  const { isRawModeSupported } = useStdin();
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 40;
  const cols = stdout?.columns ?? 120;

  const { events, loading } = useEventLog({ repoFilter, predicate, sinceTs });
  const { filterText, setFilterText, pivot, setPivot, filtered } = useFilter(events);

  // Reserve rows: header(1) + status(1) + filter(1) = 3 chrome rows
  const visibleRows = Math.max(1, rows - 3);
  const { selectedIndex, scrollOffset, moveUp, moveDown, pageUp, pageDown, jumpToBottom } =
    useSelection(filtered.length, visibleRows);

  const [filterFocused, setFilterFocused] = useState(false);
  const [showDetail, setShowDetail] = useState(false);

  const selectedEvent = filtered[selectedIndex] ?? null;

  useInput((input, key) => {
    if (filterFocused) {
      if (key.escape) {
        setFilterFocused(false);
        setFilterText("");
        setPivot(null);
      }
      return;
    }

    if (key.escape) {
      setShowDetail(false);
      setPivot(null);
      setFilterText("");
      return;
    }
    if (input === "q" || (key.ctrl && input === "c")) {
      exit();
      return;
    }
    if (input === "j" || key.downArrow) { moveDown(); return; }
    if (input === "k" || key.upArrow) { moveUp(); return; }
    if (key.pageDown) { pageDown(); return; }
    if (key.pageUp) { pageUp(); return; }
    if (input === "G") { jumpToBottom(); return; }
    if (input === "/") { setFilterFocused(true); return; }
    if (key.return) { setShowDetail((v) => !v); return; }
    if (input === "t" && selectedEvent?.traceId) {
      setPivot({ type: "trace", id: selectedEvent.traceId });
      return;
    }
    if (input === "o") {
      const orchId = selectedEvent?.attributes["catalyst.orchestrator.id"];
      if (orchId) { setPivot({ type: "orch", id: orchId }); }
      return;
    }
    if (input === "r") { setPivot(null); return; }
  }, { isActive: isRawModeSupported ?? true });

  if (loading) {
    return <Text>Loading events…</Text>;
  }

  const detailHeight =
    showDetail && selectedEvent ? Math.min(20, Math.floor(rows / 3)) + 1 : 0;
  const listRows = Math.max(1, visibleRows - detailHeight);

  return (
    <Box flexDirection="column" height={rows}>
      <Header />
      <EventList
        events={filtered}
        selectedIndex={selectedIndex}
        scrollOffset={scrollOffset}
        visibleRows={listRows}
        columns={cols}
      />
      {showDetail && selectedEvent && <DetailPane event={selectedEvent} />}
      <Box flexDirection="row">
        <Text dimColor>{`  ${filtered.length}/${events.length} events`}</Text>
        {pivot && (
          <Text color="cyan">{`  [${pivot.type} pivot active — r to reset]`}</Text>
        )}
      </Box>
      <FilterInput
        value={filterText}
        focused={filterFocused}
        onChange={setFilterText}
        pivot={pivot}
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
      const ms = unit.startsWith("h")
        ? n * 3600000
        : unit.startsWith("m")
          ? n * 60000
          : n * 1000;
      sinceTs = new Date(Date.now() - ms).toISOString();
    } else {
      sinceTs = raw;
    }
  } else if (arg === "--since-line") {
    // --since-line is silently ignored; backlog approach is used instead
    i++;
  } else if (arg === "--help" || arg === "-h") {
    console.info("Usage: catalyst-hud [--repo PATTERN] [--since TIME] [--filter JQ]");
    console.info("");
    console.info("Keybindings:");
    console.info("  ↑/↓ or j/k   move selection");
    console.info("  PgUp/PgDn    page through history");
    console.info("  Enter        toggle detail pane");
    console.info("  /            focus filter input");
    console.info("  Esc          clear filter / exit detail");
    console.info("  t            pivot to selected row's traceId");
    console.info("  o            pivot to selected row's orchestratorId");
    console.info("  r            clear pivot, back to live tail");
    console.info("  q            quit");
    process.exit(0);
  }
}

if (!process.stdin.isTTY) {
  process.stderr.write(
    "catalyst-hud requires an interactive terminal.\n" +
    "Open a fresh terminal tab and run catalyst-hud there — not inside a Claude Code session.\n",
  );
  process.exit(1);
}

render(<App repoFilter={repoFilter} predicate={predicate} sinceTs={sinceTs} />);
