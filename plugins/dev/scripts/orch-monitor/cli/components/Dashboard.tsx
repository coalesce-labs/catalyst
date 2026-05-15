import { useState, useEffect, useMemo } from "react";
import { Box, Text, useInput } from "ink";

import type { BrokerInterest } from "../lib/broker-interests-reader.ts";
import { readBrokerInterests } from "../lib/broker-interests-reader.ts";
import type { WorkerSignal } from "../lib/worker-signals-reader.ts";
import { readWorkerSignals } from "../lib/worker-signals-reader.ts";
import type { OrchState } from "../lib/orch-state-reader.ts";
import { readOrchStates } from "../lib/orch-state-reader.ts";
import type { RunRow } from "../lib/runs-reader.ts";
import { readRunRows } from "../lib/runs-reader.ts";
import type { BrokerState } from "../lib/broker-key-health.ts";
import {
  DASHBOARD_VIEWS,
  dashboardViewLabel,
  type DashboardView,
} from "../lib/dashboard-format.ts";

import { InterestList } from "./InterestList.tsx";
import { WorkerList } from "./WorkerList.tsx";
import { OrchList } from "./OrchList.tsx";
import { RunsList } from "./RunsList.tsx";

interface DashboardProps {
  visibleRows: number;
  cols: number;
  brokerState: BrokerState | null;
  onClose: () => void;
}

interface DashboardState {
  interests: BrokerInterest[];
  workers: WorkerSignal[];
  orchs: OrchState[];
  runs: RunRow[];
}

function readAll(): DashboardState {
  return {
    interests: readBrokerInterests(),
    workers: readWorkerSignals(),
    orchs: readOrchStates(),
    runs: readRunRows(),
  };
}

function pickSelectedRow(view: DashboardView, state: DashboardState, idx: number): unknown {
  if (view === "interests") return state.interests[idx] ?? null;
  if (view === "workers") return state.workers[idx]?.raw ?? null;
  if (view === "orchs") return state.orchs[idx]?.raw ?? null;
  return state.runs[idx]?.raw ?? null;
}

function rowCount(view: DashboardView, state: DashboardState): number {
  if (view === "interests") return state.interests.length;
  if (view === "workers") return state.workers.length;
  if (view === "orchs") return state.orchs.length;
  return state.runs.length;
}

export function Dashboard({ visibleRows, cols, brokerState, onClose }: DashboardProps) {
  const [view, setView] = useState<DashboardView>("interests");
  const [data, setData] = useState<DashboardState>(() => readAll());
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [showDetail, setShowDetail] = useState(false);
  const [detailScrollTop, setDetailScrollTop] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setData(readAll()), 5000);
    return () => clearInterval(id);
  }, []);

  const total = rowCount(view, data);

  useEffect(() => {
    if (selectedIndex >= total) setSelectedIndex(Math.max(0, total - 1));
  }, [total, selectedIndex]);

  // Reserve rows for the tab bar (1), the bottom footer hint (1), and the
  // list's own header + separator + summary row (3 inside the list). The list
  // body — including the in-list header/separator — gets the rest.
  const tabRow = 1;
  const footerRow = 1;
  const detailFootprint = showDetail ? Math.min(Math.max(8, Math.floor(visibleRows / 2)), visibleRows - 4) : 0;
  const listRows = Math.max(3, visibleRows - tabRow - footerRow - detailFootprint);
  // Inside the list we reserve 2 rows for headers + 1 for the footer summary.
  const listBodyRows = Math.max(1, listRows - 3);

  useEffect(() => {
    if (selectedIndex < scrollOffset) {
      setScrollOffset(Math.max(0, selectedIndex));
    } else if (selectedIndex >= scrollOffset + listBodyRows) {
      setScrollOffset(Math.max(0, selectedIndex - listBodyRows + 1));
    }
  }, [selectedIndex, scrollOffset, listBodyRows]);

  const selectedRowJson = useMemo(() => {
    const row = pickSelectedRow(view, data, selectedIndex);
    return JSON.stringify(row, null, 2);
  }, [view, data, selectedIndex]);

  const detailLines = useMemo(() => selectedRowJson.split("\n"), [selectedRowJson]);
  const detailContentRows = Math.max(1, detailFootprint - 2);
  const maxDetailScroll = Math.max(0, detailLines.length - detailContentRows);

  useEffect(() => {
    setDetailScrollTop(0);
  }, [selectedIndex, view, showDetail]);

  useInput((input, key) => {
    if (showDetail) {
      if (input === "j" || key.downArrow) { setDetailScrollTop((t) => Math.min(maxDetailScroll, t + 1)); return; }
      if (input === "k" || key.upArrow) { setDetailScrollTop((t) => Math.max(0, t - 1)); return; }
      if (key.escape || key.return) { setShowDetail(false); return; }
      return;
    }
    if (input === "i" || key.escape) { onClose(); return; }
    if (key.tab) {
      const next = DASHBOARD_VIEWS[(DASHBOARD_VIEWS.indexOf(view) + 1) % DASHBOARD_VIEWS.length] ?? "interests";
      setView(next);
      setSelectedIndex(0);
      setScrollOffset(0);
      return;
    }
    if (input === "1") { setView("interests"); setSelectedIndex(0); setScrollOffset(0); return; }
    if (input === "2") { setView("workers"); setSelectedIndex(0); setScrollOffset(0); return; }
    if (input === "3") { setView("orchs"); setSelectedIndex(0); setScrollOffset(0); return; }
    if (input === "4") { setView("runs"); setSelectedIndex(0); setScrollOffset(0); return; }
    if (input === "j" || key.downArrow) {
      setSelectedIndex((i) => Math.min(Math.max(0, total - 1), i + 1));
      return;
    }
    if (input === "k" || key.upArrow) {
      setSelectedIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (key.pageDown) { setSelectedIndex((i) => Math.min(Math.max(0, total - 1), i + listBodyRows)); return; }
    if (key.pageUp) { setSelectedIndex((i) => Math.max(0, i - listBodyRows)); return; }
    if (input === "G") { setSelectedIndex(Math.max(0, total - 1)); return; }
    if (key.return) { setShowDetail(true); return; }
  });

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box flexDirection="row" paddingX={1}>
        {DASHBOARD_VIEWS.map((v, i) => {
          const active = v === view;
          return (
            <Box key={v} marginRight={2}>
              <Text color={active ? "cyan" : undefined} bold={active} dimColor={!active}>
                {`${i + 1}: ${dashboardViewLabel(v)}${active ? " ◀" : ""}`}
              </Text>
            </Box>
          );
        })}
      </Box>
      <Box flexDirection="column" flexGrow={1} borderStyle="round" borderColor="cyan" paddingX={1}>
        {view === "interests" && (
          <InterestList
            interests={data.interests}
            selectedIndex={selectedIndex}
            scrollOffset={scrollOffset}
            visibleRows={listBodyRows}
            cols={cols - 4}
            brokerState={brokerState}
          />
        )}
        {view === "workers" && (
          <WorkerList
            workers={data.workers}
            selectedIndex={selectedIndex}
            scrollOffset={scrollOffset}
            visibleRows={listBodyRows}
            cols={cols - 4}
            waitingSessions={brokerState?.waitingSessions}
          />
        )}
        {view === "orchs" && (
          <OrchList
            orchs={data.orchs}
            selectedIndex={selectedIndex}
            scrollOffset={scrollOffset}
            visibleRows={listBodyRows}
            cols={cols - 4}
          />
        )}
        {view === "runs" && (
          <RunsList
            rows={data.runs}
            selectedIndex={selectedIndex}
            scrollOffset={scrollOffset}
            visibleRows={listBodyRows}
            cols={cols - 4}
          />
        )}
      </Box>
      {showDetail && (
        <Box flexDirection="column" flexShrink={0} borderStyle="single" borderColor="gray" paddingX={1}>
          <Text color="cyan" bold>{`Detail · j/k scroll · Enter/Esc close (${detailScrollTop + 1}/${detailLines.length})`}</Text>
          {detailLines.slice(detailScrollTop, detailScrollTop + detailContentRows).map((line, i) => (
            <Text key={i} dimColor>{line}</Text>
          ))}
        </Box>
      )}
      <Box flexShrink={0} paddingX={1}>
        <Text dimColor>Tab: switch view  ·  1-4: jump  ·  j/k: move  ·  Enter: detail  ·  Esc / i: close</Text>
      </Box>
    </Box>
  );
}
