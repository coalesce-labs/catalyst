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
import { useLinearTicket } from "../components/use-linear-ticket";
import { TicketRailCards } from "./ticket-rail";
import { WorkerDetailBody } from "./worker-detail-body";
import { WorkerRailExtra } from "./worker-rail-extra";
import { useWorkerDetailModel } from "./use-worker-detail-model";
import { readWorkerScalars } from "./worker-detail-data";
import { useRepoIconMap } from "./repo-icon-context";
import { resolveEntityMark } from "./entity-icon";

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
// CTL-1003 §B1: the TICKET property rows moved into ticket-rail.tsx's Properties
// card (the floating rail). Only the WORKER rows remain here (the worker page
// keeps the flat Shell PropertiesRail).
function workerRows(w: BoardWorker | undefined, mark: ReturnType<typeof resolveEntityMark>): PropertyRow[] {
  // CTL-914 (DETAIL3): the worker rail's BoardWorker scalar fallbacks — every
  // value is the resident AVAILABLE-NOW field or an honest null/dimmed marker.
  const scalars = readWorkerScalars(w);
  return [
    { label: "Status", value: w ? activeLabel(w.activeState, w.working) : undefined },
    { label: "Phase", value: w?.phase },
    // CTL-1258: Repo + Team orient by the project mark (glyph or favicon).
    { label: "Repo", value: w?.repo, mark },
    { label: "Team", value: w?.team, mark },
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

function activeLabel(state: BoardWorker["activeState"], working: boolean): string {
  if (state === "active") return working ? "Working" : "Active";
  if (state === "stuck") return "Stuck";
  return "Settled";
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
  // CTL-974: the LIVE Linear {title, description} from /api/linear-ticket — ONE
  // fetch lifted to the route so the Shell chrome title (breadcrumb/doc title)
  // AND the page body share it. Fail-open: nulls until/unless Linear answers, so
  // the chrome falls back to the resident board title and the body to its skeleton.
  const linear = useLinearTicket(id);

  return (
    <>
      <Shell
        kind={kind}
        id={id}
        search={search}
        listIds={listIds}
        live={{ working: ticket?.working ?? false, activeState: ticket?.activeState ?? null }}
        // CTL-996: the visible chrome title is null — the Shell renders only the
        // live dot + mono id, and the body <h1> owns the SINGLE visible title.
        title={null}
        // CTL-1003 §A1: bare chrome — no second header bar, no floating mono key/
        // dot; the app shell's single header owns the breadcrumb + the prev/next
        // chevrons portal into its action slot.
        chrome="bare"
        // CTL-1003 §B1: the floating rail cards (Properties · Labels · Project ·
        // Relations · Dependencies) replace the flat Properties rail; worker rail
        // untouched.
        rail={
          <TicketRailCards
            linear={linear}
            ticket={ticket}
            tickets={payload?.tickets ?? []}
          />
        }
        streamHealth={health}
      >
        {/* The ticket reading page — title + status row + Held + the Spec/
            Lifecycle/Cost/Activity tabs. DETAIL7 (CTL-918): the resident workers
            are passed so the active lifecycle node can tail the live stream.
            CTL-999: the whole `linear` fetch + the route `id` are passed so an
            off-board (Done/archived) ticket still renders the full reading page
            from the live fetch alone. CTL-996: `search` drives the active tab. */}
        <TicketDetailPage
          id={id}
          ticket={ticket}
          workers={payload?.workers ?? []}
          linear={linear}
          search={search}
        />
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

  // WORKER-DETAIL v2 Pass A (§1A): the live model is hoisted HERE (the parent of
  // both the Shell rail and the body) and subscribed ONCE, so the rail's
  // Diagnostics group and the body's Now view read the SAME SSE buffer — no second
  // stream/signal/burn fetch. The rail consolidates to ONE column: the shared
  // Properties rows (workerRows) PLUS the worker-only Diagnostics + Timeline groups
  // passed through Shell's `railExtra` slot (the ticket page's rail is untouched —
  // it never sets railExtra).
  const model = useWorkerDetailModel(worker);

  // CTL-1258: the project mark for the rail Repo/Team rows, resolved from the
  // worker's repo (the shared icon context mounted by the AppShell route tree).
  const icons = useRepoIconMap();
  const mark = resolveEntityMark(worker?.repo, icons);

  return (
    <>
      <Shell
        kind={kind}
        id={id}
        search={search}
        listIds={listIds}
        live={{ working: worker?.working ?? false, activeState: worker?.activeState ?? null }}
        title={worker?.name ?? id}
        properties={workerRows(worker, mark)}
        railExtra={
          <WorkerRailExtra
            worker={worker}
            signal={model.signal}
            liveDiagnostics={model.liveDiagnostics}
            currentPhase={worker?.phase ?? "—"}
          />
        }
        streamHealth={health}
      >
        <WorkerDetailBody
          id={id}
          worker={worker}
          model={model}
          tickets={payload?.tickets ?? []}
          search={search}
        />
      </Shell>
      <DetailOverlays payload={payload} focus={{ kind: "worker", id }} />
    </>
  );
}
