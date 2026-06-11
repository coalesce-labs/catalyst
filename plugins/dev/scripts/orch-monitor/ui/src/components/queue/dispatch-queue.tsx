// dispatch-queue.tsx — "Dispatching next" ranked list (CTL-1015 §3).
//
// NOT a table: a calm div list with inset hairlines only, explicit departure-board
// position ordinals (1st, 2nd…) that are GLOBAL across host groups, and a
// dispatches-next affordance on the rows that will fill freeing slots. Plain data
// props only (CTL-1016 mountability). Rank order is the queue order the read-model
// already produced via the shared compareDispatchOrder (lib/dispatch-rank.mjs).
import { Fragment, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { C } from "../../board/board-tokens";
import { ScopeChip } from "../../board/Board";
import {
  enterVariants,
  enterVariantsReduced,
  reduceTransition,
  rowTransition,
  useReducedMotion,
} from "../../board/motion-utils";
import {
  groupQueueByHost,
  queueHostMode,
  type QueueHostGroup,
} from "../../board/queue-grouping";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { BoardQueueItem } from "../../board/types";
import { ordinal, fmtAge } from "./queue-model";
import { QueueRowShell } from "./queue-row";

const DISPATCH_BG = "rgba(65,189,125,0.05)";

// One ranked dispatch row. `globalRank` is the 1-based GLOBAL position (ordinals
// stay global within host groups). `dispatchable` lights the calm green tint;
// `isFirstDispatch` renders the ordinal in green (the literal "next").
function DispatchRow({
  q,
  globalRank,
  dispatchable,
  isFirstDispatch,
  multiHost,
  withTopHairline,
  onOpenTicket,
}: {
  q: BoardQueueItem;
  globalRank: number;
  dispatchable: boolean;
  isFirstDispatch: boolean;
  multiHost: boolean;
  withTopHairline: boolean;
  onOpenTicket?: (key: string) => void;
}) {
  const reduced = useReducedMotion();
  const waitedMs = q.createdAt ? Date.now() - new Date(q.createdAt).getTime() : NaN;
  const age = fmtAge(waitedMs);
  return (
    <motion.div
      layoutId={`dq-${q.id}`}
      layout="position"
      variants={reduced ? enterVariantsReduced : enterVariants}
      initial="initial"
      animate="animate"
      exit="exit"
      transition={reduceTransition(rowTransition, reduced)}
    >
      <QueueRowShell
        gutter={
          <span
            style={{
              width: 34,
              textAlign: "right",
              fontFamily: C.mono,
              fontSize: 11,
              fontVariantNumeric: "tabular-nums",
              color: isFirstDispatch ? C.green : C.fgDim,
              lineHeight: "18px",
              flex: "0 0 auto",
            }}
          >
            {ordinal(globalRank)}
          </span>
        }
        repo={q.repo}
        ticketKey={q.id}
        priority={q.priority}
        title={q.title}
        withTopHairline={withTopHairline}
        highlightBg={dispatchable ? DISPATCH_BG : undefined}
        onClick={onOpenTicket ? () => onOpenTicket(q.id) : undefined}
        meta={
          <>
            <ScopeChip scope={q.scope} estimate={q.estimate} estimateDisplay={q.estimateDisplay} />
            {age && (
              <span style={{ fontFamily: C.mono, fontSize: 11, fontVariantNumeric: "tabular-nums", color: C.fgDim, lineHeight: "18px" }}>
                {age}
              </span>
            )}
            {multiHost && (
              <span style={{ fontFamily: C.mono, fontSize: 11, color: q.host ? C.fgMuted : C.fgDim, lineHeight: "18px" }}>
                {q.host?.name ?? "—"}
              </span>
            )}
          </>
        }
      />
    </motion.div>
  );
}

function EmptyState({ freeSlots }: { freeSlots: number }) {
  const copy =
    freeSlots > 0
      ? `Queue is clear — ${freeSlots} open. While slots are open, eligible work dispatches the moment it appears; a line only forms when demand outpaces the fleet.`
      : "Nothing waiting. New eligible tickets line up here in dispatch order until a slot frees.";
  return <div style={{ fontSize: 12, color: C.fgMuted, padding: "18px 8px" }}>{copy}</div>;
}

export function DispatchQueue({
  queue,
  freeSlots,
  onOpenTicket,
}: {
  queue: BoardQueueItem[];
  freeSlots: number;
  onOpenTicket?: (key: string) => void;
}) {
  const multiHost = queueHostMode(queue) === "multi";
  const [groupByNode, setGroupByNode] = useState(false);
  const grouped = multiHost && groupByNode;

  // dispatches-next affordance: the top min(freeSlots, queue.length) rows tint.
  const dispatchCount = Math.min(Math.max(0, freeSlots), queue.length);

  // GLOBAL rank: position within the full queue (1-based), keyed by id so grouped
  // sections preserve the same number the flat list would show.
  const globalRankById = new Map<string, number>();
  queue.forEach((q, i) => globalRankById.set(q.id, i + 1));

  const renderRow = (q: BoardQueueItem, indexInList: number) => {
    const globalRank = globalRankById.get(q.id) ?? indexInList + 1;
    const dispatchable = globalRank <= dispatchCount;
    const isFirstDispatch = freeSlots > 0 && globalRank === 1;
    return (
      <DispatchRow
        key={q.id}
        q={q}
        globalRank={globalRank}
        dispatchable={dispatchable}
        isFirstDispatch={isFirstDispatch}
        multiHost={multiHost}
        withTopHairline={indexInList > 0}
        onOpenTicket={onOpenTicket}
      />
    );
  };

  return (
    <section>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: C.fg }}>Dispatching next</span>
        <span style={{ fontSize: 13, fontWeight: 400, color: C.fgDim }}>· {queue.length} waiting</span>
        <span style={{ flex: 1 }} />
        {multiHost && (
          <ToggleGroup
            type="single"
            value={groupByNode ? "node" : "rank"}
            onValueChange={(v) => v && setGroupByNode(v === "node")}
            variant="outline"
            size="sm"
          >
            <ToggleGroupItem value="rank" style={{ fontSize: 12, color: !groupByNode ? C.fg : C.fgMuted }}>
              Global rank
            </ToggleGroupItem>
            <ToggleGroupItem value="node" style={{ fontSize: 12, color: groupByNode ? C.fg : C.fgMuted }}>
              By node
            </ToggleGroupItem>
          </ToggleGroup>
        )}
      </div>

      {queue.length === 0 ? (
        <EmptyState freeSlots={freeSlots} />
      ) : grouped ? (
        <div>
          {groupQueueByHost(queue).map((g: QueueHostGroup) => (
            <Fragment key={g.host?.id ?? g.label}>
              <div style={{ padding: "6px 8px", background: C.s1, borderRadius: 6 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: C.fg }}>{g.label}</span>
                <span style={{ fontSize: 12, color: C.fgDim }}> · {g.items.length} queued</span>
              </div>
              <AnimatePresence initial={false}>
                {g.items.map((q, i) => renderRow(q, i))}
              </AnimatePresence>
            </Fragment>
          ))}
        </div>
      ) : (
        <div>
          <AnimatePresence initial={false}>
            {queue.map((q, i) => renderRow(q, i))}
          </AnimatePresence>
        </div>
      )}
    </section>
  );
}
