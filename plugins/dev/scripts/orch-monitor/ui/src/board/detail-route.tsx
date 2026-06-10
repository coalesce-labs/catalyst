// detail-route.tsx — the route container that mounts the shared <Shell> chrome
// for /ticket/$id and /worker/$id (CTL-912 / DETAIL1). It subscribes to the
// resident board payload (the SAME `connectBoard` transport the board uses),
// resolves the walk list + the entity through the SHARED `resolveList` (so the
// pager order matches the board), maps the entity to the shell's chrome props,
// and renders the page body in the <DetailBody> slot.
//
// SCOPE: this ticket (DETAIL1) owns the CHROME — the breadcrumb, pager, live-dot
// title, Properties rail skeleton, footer, and keyboard. The page BODIES (ticket
// spine/telemetry/runs in DETAIL2, worker burn-strip/tail/diagnostics in DETAIL3)
// drop into the slot later; here the body is an honest "coming in DETAIL2/3"
// placeholder. The Properties rail already binds the shared cheap rows off the
// resident payload (AVAILABLE-NOW); unplumbed rows render dimmed, never faked.

import { useEffect, useState } from "react";
import { useAtom } from "jotai";
import { connectBoard } from "./board-client";
import { resolveListIds } from "./list-order";
import { Shell, type PropertyRow, type ShellKind, type StreamHealth } from "./Shell";
import { CommandPalette, KeyCheatsheet } from "./CommandPalette";
import { cheatsheetOpenAtom } from "./nav-store";
import type { PaletteFocus } from "./palette-actions";
import type { BoardPayload, BoardTicket, BoardWorker } from "./types";
import type { DetailSearch } from "./route-search";
import { TicketDetailPage } from "../components/ticket-detail-page";
import { WorkerDetailBody } from "./worker-detail-body";
import { readWorkerScalars } from "./worker-detail-data";

// ── resident payload subscription (same transport as Board.tsx) ─────────────
function useBoardPayload(): { payload: BoardPayload | null; health: StreamHealth } {
  const [payload, setPayload] = useState<BoardPayload | null>(null);
  const [health, setHealth] = useState<StreamHealth>({ state: "unknown" });

  useEffect(() => {
    let alive = true;
    let lastFrameAt: number | null = null;
    const conn = connectBoard({
      onSnapshot: (p) => {
        if (!alive) return;
        lastFrameAt = Date.now();
        setPayload(p);
      },
      onStatus: (s) => {
        if (!alive) return;
        // Map the board transport's connection status to a footer stream-health.
        // We only ever claim "live" when a frame actually arrived (never fabricate).
        if (s === "connected" && lastFrameAt != null) {
          setHealth({ state: "live", lastFrameAgoMs: Date.now() - lastFrameAt });
        } else if (s === "connected") {
          setHealth({ state: "unknown" }); // connected but no frame yet — honest dim
        } else {
          setHealth({ state: "reconnecting" });
        }
      },
    });
    return () => {
      alive = false;
      conn.close();
    };
  }, []);

  return { payload, health };
}

// ── property-row assembly (shared cheap rows; unplumbed → undefined → dimmed) ─
function ticketRows(t: BoardTicket | undefined): PropertyRow[] {
  // Every value is the AVAILABLE-NOW BoardTicket field, or `undefined` (dimmed)
  // when the entity isn't in the resident payload yet (a cold-linked Done ticket).
  return [
    { label: "Status", value: t ? `${t.linearState} · ${activeLabel(t.activeState, t.working)}` : undefined },
    { label: "Phase", value: t?.phase },
    { label: "Priority", value: t ? priorityLabel(t.priority) : undefined },
    { label: "Estimate", value: t?.estimate != null ? `${t.estimate} pts` : t ? null : undefined },
    { label: "Scope", value: t ? (t.scope ?? null) : undefined },
    { label: "Project", value: t ? (t.project ?? null) : undefined },
    { label: "Repo", value: t?.repo },
    { label: "Team", value: t?.team },
    { label: "Updated", value: t?.updatedAt },
    { label: "PR", value: t?.pr != null ? `#${t.pr}` : t ? null : undefined },
    // `model` is the CURRENT phase's signal model only — labelled honestly.
    { label: "Model (current phase)", value: t ? (t.model ?? null) : undefined },
  ];
}

function workerRows(w: BoardWorker | undefined): PropertyRow[] {
  // CTL-914 (DETAIL3): the worker rail's BoardWorker scalar fallbacks — every
  // value is the resident AVAILABLE-NOW field or an honest null/dimmed marker.
  const scalars = readWorkerScalars(w);
  return [
    { label: "Status", value: w ? activeLabel(w.activeState, w.working) : undefined },
    { label: "Phase", value: w?.phase },
    { label: "Repo", value: w?.repo },
    { label: "Team", value: w?.team },
    { label: "Runtime", value: w?.runtimeMs != null ? fmtDuration(w.runtimeMs) : w ? null : undefined },
    { label: "Cost", value: scalars.costUSD != null ? `$${scalars.costUSD.toFixed(2)}` : w ? null : undefined },
    // CTL-915 (DETAIL4 / BFF6 P7): the OS pid of the bg worker. null when the
    // worker carries none (dimmed, never fabricated).
    { label: "PID", value: scalars.pid != null ? String(scalars.pid) : w ? null : undefined },
    // Both id spaces — the CC-UUID (keys Prometheus/Loki claude-code) and the
    // catalyst sess_ id (keys the catalyst.session streams; null when no db row).
    // Surfaced together so the Loki heartbeat + catalyst lifecycle joins key off
    // the right id space (design §5.2 id-split).
    { label: "Session", value: scalars.sessionId ?? (w ? null : undefined) },
    { label: "Catalyst id", value: scalars.catalystSessionId ?? (w ? null : undefined) },
  ];
}

function activeLabel(state: BoardTicket["activeState"], working: boolean): string {
  if (state === "active") return working ? "Working" : "Active";
  if (state === "stuck") return "Stuck";
  return "Settled";
}

function priorityLabel(p: number): string {
  return p > 0 ? `P${p}` : "—";
}

function fmtDuration(ms: number): string {
  const m = Math.floor(ms / 60000);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

// ── detail overlays (CTL-916 / DETAIL5) ──────────────────────────────────────
/** Mount the ⌘K palette + the `?` cheatsheet for a detail route. The palette
 *  reads its open-state off `paletteOpenAtom` (toggled by the shell's ⌘K binding)
 *  and renders the resident-payload command list scoped to the focused entity; the
 *  cheatsheet reads `cheatsheetOpenAtom`. Both are fixed-position siblings of the
 *  Shell, so they render OUTSIDE the shell's scroll region. */
function DetailOverlays({
  payload,
  focus,
}: {
  payload: BoardPayload | null;
  focus: PaletteFocus;
}) {
  const [cheatsheetOpen, setCheatsheetOpen] = useAtom(cheatsheetOpenAtom);
  return (
    <>
      <CommandPalette payload={payload} focus={focus} />
      <KeyCheatsheet open={cheatsheetOpen} onClose={() => setCheatsheetOpen(false)} />
    </>
  );
}

// ── route components ─────────────────────────────────────────────────────────
export function TicketDetailRoute({ id, search }: { id: string; search: DetailSearch }) {
  const { payload, health } = useBoardPayload();
  const kind: ShellKind = "ticket";
  const listIds = payload ? resolveListIds(payload, { kind, lens: search.lens, col: search.col }) : [];
  const ticket = payload?.tickets.find((t) => t.id === id);

  return (
    <>
      <Shell
        kind={kind}
        id={id}
        search={search}
        listIds={listIds}
        live={{ working: ticket?.working ?? false, activeState: ticket?.activeState ?? null }}
        title={ticket?.title ?? id}
        properties={ticketRows(ticket)}
        streamHealth={health}
      >
        {/* DETAIL2 (CTL-913): the lifecycle aggregate body — header · PIPELINE rail ·
            HELD banner · LIFECYCLE SPINE + compact gantt · COMMS · ACTIVITY — all
            off the RESIDENT BoardTicket + phaseSummary (zero new endpoints).
            DETAIL7 (CTL-918): the resident workers are passed so the active spine
            node can resolve its running phase's sessionId and tail the live
            stream (the same BFF SSE the worker [live] tab consumes). */}
        <TicketDetailPage ticket={ticket} workers={payload?.workers ?? []} tickets={payload?.tickets ?? []} />
      </Shell>
      <DetailOverlays payload={payload} focus={{ kind: "ticket", id }} />
    </>
  );
}

export function WorkerDetailRoute({ id, search }: { id: string; search: DetailSearch }) {
  const { payload, health } = useBoardPayload();
  const kind: ShellKind = "worker";
  const listIds = payload ? resolveListIds(payload, { kind, lens: search.lens, col: search.col }) : [];
  const worker = payload?.workers.find((w) => w.name === id);

  return (
    <>
      <Shell
        kind={kind}
        id={id}
        search={search}
        listIds={listIds}
        live={{ working: worker?.working ?? false, activeState: worker?.activeState ?? null }}
        title={worker?.name ?? id}
        properties={workerRows(worker)}
        streamHealth={health}
      >
        <WorkerDetailBody id={id} worker={worker} />
      </Shell>
      <DetailOverlays payload={payload} focus={{ kind: "worker", id }} />
    </>
  );
}
