import { useState, useEffect, useMemo } from "react";
import { Box, Text, useInput } from "ink";

import type { BrokerInterest } from "../lib/broker-interests-reader.ts";
import { readBrokerInterests } from "../lib/broker-interests-reader.ts";
import type { WorkerSignal } from "../lib/worker-signals-reader.ts";
import { readWorkerSignals } from "../lib/worker-signals-reader.ts";
import { selectWorkers } from "../lib/read-model-workers.ts";
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
import { WorkerList, type WorkerSortKey } from "./WorkerList.tsx";
import { OrchList, type OrchSortKey } from "./OrchList.tsx";
import { RunsList } from "./RunsList.tsx";

type SortDir = "asc" | "desc";

const WORKER_SORT_CYCLE: WorkerSortKey[] = ["heartbeat", "status", "phase", "pr", "worker"];
const ORCH_SORT_CYCLE: OrchSortKey[] = ["started", "active", "wave"];

interface DashboardProps {
  visibleRows: number;
  cols: number;
  brokerState: BrokerState | null;
  onClose: () => void;
  /**
   * CTL-919 / HUD1: the local node's name, resolved through the shared
   * read-model contract (lib/read-model-client → read-model-host.localHostRef).
   * A single-host fleet shows exactly this one node (the identity no-op) at the
   * right of the view tabs; the eventual multi-node HUD groups by host through
   * the SAME contract. Optional/additive — absent ⇒ no node label rendered.
   */
  nodeName?: string;
  /**
   * CTL-920 / HUD2: the Workers view's PRIMARY state, mapped from the shared
   * read-model SSE (the SAME assembled BoardWorker[] the web/iPad render). When
   * non-null the Dashboard renders THESE rows instead of re-deriving them from
   * raw `workers/*.json` scans — one assembly, many readers. When null the
   * read-model is unavailable (server down) and the Dashboard falls back to its
   * raw-file scan so the HUD never goes dark.
   */
  readModelWorkers?: WorkerSignal[] | null;
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

export function Dashboard({
  visibleRows,
  cols,
  brokerState,
  onClose,
  nodeName,
  readModelWorkers,
}: DashboardProps) {
  const [view, setView] = useState<DashboardView>("interests");
  const [data, setData] = useState<DashboardState>(() => readAll());
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [showDetail, setShowDetail] = useState(false);
  const [detailScrollTop, setDetailScrollTop] = useState(0);
  const [workerSortKey, setWorkerSortKey] = useState<WorkerSortKey>("heartbeat");
  const [workerSortDir, setWorkerSortDir] = useState<SortDir>("desc");
  const [orchSortKey, setOrchSortKey] = useState<OrchSortKey>("started");
  const [orchSortDir, setOrchSortDir] = useState<SortDir>("desc");

  useEffect(() => {
    const id = setInterval(() => setData(readAll()), 5000);
    return () => clearInterval(id);
  }, []);

  // CTL-920 / HUD2: prefer the read-model-backed workers (the shared assembled
  // BoardWorker[] the web/iPad render). When the read-model is unavailable
  // (server down ⇒ prop is null), fall back to the raw `workers/*.json` scan so
  // the HUD never goes dark. The em-dash "—" entries the read-model worker slice
  // omits (PR, worktree) render identically to a raw signal that lacks them.
  const effectiveWorkers = selectWorkers(readModelWorkers ?? null, data.workers);

  const sortedWorkers = useMemo(() => {
    const arr = [...effectiveWorkers];
    const dir = workerSortDir === "asc" ? 1 : -1;
    arr.sort((a, b) => {
      let av: number | string, bv: number | string;
      switch (workerSortKey) {
        case "worker": av = a.workerName ?? ""; bv = b.workerName ?? ""; break;
        case "status": av = a.status ?? ""; bv = b.status ?? ""; break;
        case "phase": av = a.phase ?? (dir > 0 ? Infinity : -Infinity); bv = b.phase ?? (dir > 0 ? Infinity : -Infinity); break;
        case "pr": av = a.pr?.number ?? (dir > 0 ? Infinity : -Infinity); bv = b.pr?.number ?? (dir > 0 ? Infinity : -Infinity); break;
        case "heartbeat": {
          const at = a.lastHeartbeat ? Date.parse(a.lastHeartbeat) : NaN;
          const bt = b.lastHeartbeat ? Date.parse(b.lastHeartbeat) : NaN;
          av = isNaN(at) ? (dir > 0 ? Infinity : -Infinity) : at;
          bv = isNaN(bt) ? (dir > 0 ? Infinity : -Infinity) : bt;
          break;
        }
      }
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
    return arr;
  }, [effectiveWorkers, workerSortKey, workerSortDir]);

  const sortedOrchs = useMemo(() => {
    const arr = [...data.orchs];
    const dir = orchSortDir === "asc" ? 1 : -1;
    arr.sort((a, b) => {
      let av: number | string, bv: number | string;
      switch (orchSortKey) {
        case "orch": av = a.orchestrator ?? a.id ?? ""; bv = b.orchestrator ?? b.id ?? ""; break;
        case "wave": av = a.currentWave ?? (dir > 0 ? Infinity : -Infinity); bv = b.currentWave ?? (dir > 0 ? Infinity : -Infinity); break;
        case "active": av = a.workersCount.active; bv = b.workersCount.active; break;
        case "queue": av = a.queueLength; bv = b.queueLength; break;
        case "started": {
          const at = a.startedAt ? Date.parse(a.startedAt) : NaN;
          const bt = b.startedAt ? Date.parse(b.startedAt) : NaN;
          av = isNaN(at) ? (dir > 0 ? Infinity : -Infinity) : at;
          bv = isNaN(bt) ? (dir > 0 ? Infinity : -Infinity) : bt;
          break;
        }
        case "parallel": av = a.maxParallel ?? (dir > 0 ? Infinity : -Infinity); bv = b.maxParallel ?? (dir > 0 ? Infinity : -Infinity); break;
      }
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
    return arr;
  }, [data.orchs, orchSortKey, orchSortDir]);

  const sortedData = useMemo<DashboardState>(() => ({
    ...data,
    workers: sortedWorkers,
    orchs: sortedOrchs,
  }), [data, sortedWorkers, sortedOrchs]);

  const total = rowCount(view, sortedData);

  useEffect(() => {
    if (selectedIndex >= total && total > 0) setSelectedIndex(Math.max(0, total - 1));
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
    const row = pickSelectedRow(view, sortedData, selectedIndex);
    return JSON.stringify(row, null, 2);
  }, [view, sortedData, selectedIndex]);

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
    if (input === "s") {
      if (view === "workers") {
        const next = WORKER_SORT_CYCLE[(WORKER_SORT_CYCLE.indexOf(workerSortKey) + 1) % WORKER_SORT_CYCLE.length] ?? "heartbeat";
        setWorkerSortKey(next);
        setSelectedIndex(0);
        setScrollOffset(0);
      } else if (view === "orchs") {
        const next = ORCH_SORT_CYCLE[(ORCH_SORT_CYCLE.indexOf(orchSortKey) + 1) % ORCH_SORT_CYCLE.length] ?? "started";
        setOrchSortKey(next);
        setSelectedIndex(0);
        setScrollOffset(0);
      }
      return;
    }
    if (input === "S") {
      if (view === "workers") setWorkerSortDir((d) => (d === "asc" ? "desc" : "asc"));
      else if (view === "orchs") setOrchSortDir((d) => (d === "asc" ? "desc" : "asc"));
      setSelectedIndex(0);
      setScrollOffset(0);
      return;
    }
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
        {nodeName ? (
          <Box flexGrow={1} justifyContent="flex-end">
            <Text dimColor>{`node: ${nodeName}`}</Text>
          </Box>
        ) : null}
      </Box>
      <Box flexDirection="column" flexGrow={1} borderStyle="round" borderColor="cyan" paddingX={1}>
        {view === "interests" && (
          <InterestList
            interests={sortedData.interests}
            selectedIndex={selectedIndex}
            scrollOffset={scrollOffset}
            visibleRows={listBodyRows}
            cols={cols - 4}
            brokerState={brokerState}
          />
        )}
        {view === "workers" && (
          <WorkerList
            workers={sortedData.workers}
            selectedIndex={selectedIndex}
            scrollOffset={scrollOffset}
            visibleRows={listBodyRows}
            cols={cols - 4}
            waitingSessions={brokerState?.waitingSessions}
            sortKey={workerSortKey}
            sortDir={workerSortDir}
          />
        )}
        {view === "orchs" && (
          <OrchList
            orchs={sortedData.orchs}
            selectedIndex={selectedIndex}
            scrollOffset={scrollOffset}
            visibleRows={listBodyRows}
            cols={cols - 4}
            sortKey={orchSortKey}
            sortDir={orchSortDir}
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
        <Text dimColor>Tab: switch view  ·  1-4: jump  ·  j/k: move  ·  s/S: sort col/dir  ·  Enter: detail  ·  Esc / i: close</Text>
      </Box>
    </Box>
  );
}
