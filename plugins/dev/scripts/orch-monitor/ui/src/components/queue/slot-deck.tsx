// slot-deck.tsx — the HERO of the /queue control tower (CTL-1015 §2).
//
// A capacity-centric "worker slots" deck: each card is one maxParallel slot,
// showing what it runs (or "Open"). Dead workers hold NO slot and never appear
// here (assignSlots excludes them). Plain data props only — no snapshot hook, no
// router — so CTL-1016's Workers surface can mount it with its own payload slice.
import { AnimatePresence, motion } from "motion/react";
import { C, LIVE, PHASE, CARD_LIFT } from "../../board/board-tokens";
import {
  EntityMarker,
} from "../../board/entity-marker";
import { PhasePill, PriorityIcon, fmtRuntime } from "../../board/Board";
import {
  cardTransition,
  enterVariants,
  enterVariantsReduced,
  reduceTransition,
  useReducedMotion,
} from "../../board/motion-utils";
import type { BoardWorker, BoardTicket, BoardConfig } from "../../board/types";
import type { ClusterSignal } from "@/lib/cluster-signal";
import { assignSlots, isLiveWorker, slotLabel } from "./queue-model";
import { TickerNumber } from "./ticker-number";
import {
  aggregateClusterCapacity,
  assignClusterSlots,
  filterSlotsByNode,
  nodeCapacity,
} from "./cluster-capacity";
import type { ClusterSlot } from "./cluster-capacity";

// The state word + its color for a slot's worker (mirrors workerStatusText).
function slotState(w: BoardWorker): { word: string; color: string } {
  if (w.activeState === "dead") return { word: "dead", color: C.fgDim }; // unreachable in deck
  if (w.activeState === "stuck") return { word: "stuck", color: C.red };
  if (w.waitingOnUser) return { word: "waiting on you", color: C.yellow };
  if (w.activeState === "active") return { word: w.working ? "working" : "active", color: LIVE };
  return { word: w.activeState ?? "idle", color: C.fgDim };
}

const clamp2 = {
  display: "-webkit-box",
  WebkitLineClamp: 2,
  WebkitBoxOrient: "vertical" as const,
  overflow: "hidden",
};

function OccupiedCard({
  w,
  ticket,
  slotLabel,
  onOpenTicket,
}: {
  w: BoardWorker;
  ticket: BoardTicket | undefined;
  slotLabel: string;
  onOpenTicket?: (key: string) => void;
}) {
  const reduced = useReducedMotion();
  const st = slotState(w);
  const stuck = w.activeState === "stuck";
  const isOver = slotLabel === "OVER";
  return (
    <motion.div
      layoutId={`slot-${w.name}`}
      layout="position"
      variants={reduced ? enterVariantsReduced : enterVariants}
      initial="initial"
      animate="animate"
      exit="exit"
      transition={reduceTransition(cardTransition, reduced)}
      onClick={onOpenTicket ? () => onOpenTicket(w.ticket) : undefined}
      style={{
        display: "flex",
        flexDirection: "column",
        background: C.s2,
        border: `1px solid ${stuck ? "rgba(227,107,107,0.35)" : C.borderSubtle}`,
        borderRadius: 10,
        padding: "10px 12px",
        minHeight: 96,
        boxShadow: CARD_LIFT, // CTL-1033: control-tower slot cards float off the canvas
        cursor: onOpenTicket ? "pointer" : "default",
      }}
    >
      {/* 1. slot label row */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 10, color: isOver ? C.red : C.fgDim, letterSpacing: 1.2, textTransform: "uppercase", fontFamily: C.mono }}>
          {slotLabel}
        </span>
        <span style={{ fontSize: 10, color: st.color, fontFamily: C.mono }}>{st.word}</span>
      </div>
      {/* 2. identity row */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
        <EntityMarker repo={w.repo} state={w.activeState} fallback={PHASE[w.phase] || C.blue} />
        <span style={{ fontFamily: C.mono, fontSize: 13, fontWeight: 600, color: C.blue }}>{w.ticket}</span>
        <PriorityIcon p={ticket?.priority ?? 0} />
      </div>
      {/* 3. title (two-line clamp) */}
      <div style={{ fontSize: 12, color: C.fgMuted, lineHeight: 1.35, marginTop: 4, ...clamp2 }}>
        {ticket?.title || ""}
      </div>
      {/* 4. footer row */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: "auto", paddingTop: 8 }}>
        <PhasePill phase={w.phase} />
        <span style={{ fontFamily: C.mono, fontSize: 11, fontVariantNumeric: "tabular-nums", color: C.fgDim }}>
          {fmtRuntime(w.runtimeMs)}
        </span>
      </div>
    </motion.div>
  );
}

function EmptyCard({ slotLabel, first }: { slotLabel: string; first: boolean }) {
  const reduced = useReducedMotion();
  return (
    <motion.div
      variants={reduced ? enterVariantsReduced : enterVariants}
      initial="initial"
      animate="animate"
      exit="exit"
      transition={reduceTransition(cardTransition, reduced)}
      style={{
        display: "flex",
        flexDirection: "column",
        background: "transparent",
        border: `1px dashed ${C.borderSubtle}`,
        borderRadius: 10,
        padding: "10px 12px",
        minHeight: 96,
      }}
    >
      {/* CTL-1054: open cards share the occupied-card anatomy — "SLOT N" sits in
          the upper-LEFT corner exactly like OccupiedCard's slot-label row (same
          mono/uppercase/tracking), so a vacant slot reads as the SAME kind of
          object as an occupied one. */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 10, color: C.fgDim, letterSpacing: 1.2, textTransform: "uppercase", fontFamily: C.mono }}>
          {slotLabel}
        </span>
      </div>
      {/* "Open" reads as the status, centered in the card body; the first vacant
          slot keeps its dispatch hint underneath. */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 4,
          flex: 1,
          textAlign: "center",
        }}
      >
        <span style={{ fontSize: 12, color: C.fgDim }}>Open</span>
        {first && (
          <span style={{ fontSize: 11, color: C.fgDim, opacity: 0.7 }}>
            next eligible ticket dispatches here
          </span>
        )}
      </div>
    </motion.div>
  );
}

// RemoteSlotCard — lightweight card for a remote node's in-flight ticket (CTL-1092).
// Shows host chip + ticket id only; no worker detail (cross-node tail is CTL-885).
function RemoteSlotCard({ slot }: { slot: ClusterSlot }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        background: C.s2,
        border: `1px solid ${C.borderSubtle}`,
        borderRadius: 10,
        padding: "10px 12px",
        minHeight: 96,
        opacity: 0.8,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 10, color: C.fgDim, letterSpacing: 1.2, textTransform: "uppercase", fontFamily: C.mono }}>
          {slotLabel(slot.slotIndex + 1)}
        </span>
        <span style={{ fontSize: 10, color: C.fgDim, fontFamily: C.mono }}>remote</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8 }}>
        <span style={{ fontSize: 10, color: C.fgDim, background: C.s3, borderRadius: 4, padding: "2px 5px", fontFamily: C.mono }}>{slot.host}</span>
        <span style={{ fontFamily: C.mono, fontSize: 13, fontWeight: 600, color: C.blue }}>{slot.ticket}</span>
      </div>
    </div>
  );
}

export function SlotDeck({
  workers,
  tickets,
  config,
  onOpenTicket,
  clusterSignal = null,
  selectedNode = "all",
}: {
  workers: BoardWorker[];
  tickets: BoardTicket[];
  config: BoardConfig;
  onOpenTicket?: (key: string) => void;
  clusterSignal?: ClusterSignal | null;
  selectedNode?: string | "all";
}) {
  const infoById = new Map(tickets.map((t) => [t.id, t]));

  // Cluster-mode path: use aggregateClusterCapacity + assignClusterSlots
  if (clusterSignal && clusterSignal.nodes.length > 1) {
    const localHost = clusterSignal.nodes.find((n) => n.status === "live")?.host ?? "";
    const allSlots = assignClusterSlots({
      nodes: clusterSignal.nodes as any,
      localHost,
      localWorkers: workers,
    });
    const displaySlots = selectedNode === "all" ? allSlots : filterSlotsByNode(allSlots, selectedNode);
    const cap = selectedNode === "all"
      ? aggregateClusterCapacity(clusterSignal.nodes as any)
      : nodeCapacity(clusterSignal.nodes as any, selectedNode);

    return (
      <section>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 14 }}>
          <span style={{ display: "inline-flex", alignItems: "baseline" }}>
            <span style={{ fontFamily: C.mono, fontSize: 26, fontWeight: 700, fontVariantNumeric: "tabular-nums", color: C.fg }}>
              <TickerNumber value={cap.inFlight} />
            </span>
            <span style={{ fontFamily: C.mono, fontSize: 18, fontWeight: 500, color: C.fgDim }}>
              {" / "}{cap.maxParallel}
            </span>
          </span>
          <span style={{ fontSize: 12, color: C.fgMuted }}>
            slots in use ·{" "}
            <span style={{ color: cap.freeSlots === 0 ? C.yellow : C.fgMuted, display: "inline-flex", alignItems: "baseline" }}>
              <TickerNumber value={cap.freeSlots} />
              <span style={{ marginLeft: 4 }}>open</span>
            </span>
          </span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(264px, 1fr))", gap: 10 }}>
          <AnimatePresence initial={false}>
            {displaySlots.map((slot, i) => {
              if (!slot.occupied) {
                return <EmptyCard key={`empty-${slot.host}-${slot.slotIndex}`} slotLabel={slotLabel(slot.slotIndex + 1)} first={i === 0} />;
              }
              if (slot.worker) {
                return (
                  <OccupiedCard
                    key={`slot-${slot.worker.name}`}
                    w={slot.worker}
                    ticket={infoById.get(slot.worker.tickets?.[0] ?? "")}
                    slotLabel={slotLabel(slot.slotIndex + 1)}
                    onOpenTicket={onOpenTicket}
                  />
                );
              }
              // Remote slot with ticket label
              return <RemoteSlotCard key={`remote-${slot.host}-${slot.slotIndex}`} slot={slot} />;
            })}
          </AnimatePresence>
        </div>
      </section>
    );
  }

  // Single-host / legacy path — unchanged
  const { occupied, emptyCount, overCapacity } = assignSlots(workers, config.maxParallel);
  const dead = config.dead ?? 0;
  const over = Math.max(0, config.inFlight - config.maxParallel);
  const freeSlots = config.freeSlots;

  return (
    <section>
      {/* 2.1 utilization headline */}
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 14 }}>
        <span style={{ display: "inline-flex", alignItems: "baseline" }}>
          <span style={{ fontFamily: C.mono, fontSize: 26, fontWeight: 700, fontVariantNumeric: "tabular-nums", color: C.fg }}>
            <TickerNumber value={config.inFlight} />
          </span>
          <span style={{ fontFamily: C.mono, fontSize: 18, fontWeight: 500, color: C.fgDim }}>
            {" / "}
            {config.maxParallel}
          </span>
        </span>
        <span style={{ fontSize: 12, color: C.fgMuted }}>
          slots in use ·{" "}
          <span style={{ color: freeSlots === 0 ? C.yellow : C.fgMuted, display: "inline-flex", alignItems: "baseline" }}>
            <TickerNumber value={freeSlots} />
            <span style={{ marginLeft: 4 }}>open</span>
          </span>
          {over > 0 && <span style={{ color: C.red }}> · {over} over capacity</span>}
        </span>
        <span style={{ flex: 1 }} />
        {dead > 0 && (
          <span style={{ fontSize: 11, color: C.fgDim }}>
            {dead} dead — no slots held ↓
          </span>
        )}
      </div>

      {/* 2.2 slot deck */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(264px, 1fr))", gap: 10 }}>
        <AnimatePresence initial={false}>
          {occupied.map((w, i) => (
            <OccupiedCard
              key={`slot-${w.name}`}
              w={w}
              ticket={infoById.get(w.tickets?.[0] ?? w.ticket)}
              slotLabel={slotLabel(i + 1)}
              onOpenTicket={onOpenTicket}
            />
          ))}
          {Array.from({ length: emptyCount }).map((_, i) => (
            <EmptyCard
              key={`empty-${i}`}
              slotLabel={slotLabel(occupied.length + i + 1)}
              first={i === 0}
            />
          ))}
          {overCapacity.map((w) => (
            <OccupiedCard
              key={`slot-${w.name}`}
              w={w}
              ticket={infoById.get(w.tickets?.[0] ?? w.ticket)}
              slotLabel="OVER"
              onOpenTicket={onOpenTicket}
            />
          ))}
        </AnimatePresence>
      </div>
    </section>
  );
}

// Re-export so a caller that only needs the live-worker predicate doesn't re-derive it.
export { isLiveWorker };
