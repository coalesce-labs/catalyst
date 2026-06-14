// dead-strip.tsx — the "Dead / stale" forensics strip (CTL-1015 §5).
//
// Dead workers do NOT hold slots (deriveCapacity excludes them) — so they live in
// their own quiet strip, never in the deck or the in-flight counts. The whole
// strip is dimmed (opacity 0.55); each row reuses the shared QueueRowShell. The
// section is omitted entirely when there are no dead workers. Plain data props.
import { AnimatePresence, motion } from "motion/react";
import { C } from "../../board/board-tokens";
import { PhasePill, fmtRuntime } from "../../board/Board";
import {
  enterVariants,
  enterVariantsReduced,
  reduceTransition,
  rowTransition,
  useReducedMotion,
} from "../../board/motion-utils";
import type { BoardTicket, BoardWorker } from "../../board/types";
import { deadWorkers } from "./queue-model";
import { QueueRowShell } from "./queue-row";

function DeadRow({
  w,
  ticket,
  withTopHairline,
}: {
  w: BoardWorker;
  ticket: BoardTicket | undefined;
  withTopHairline: boolean;
}) {
  const reduced = useReducedMotion();
  return (
    <motion.div
      variants={reduced ? enterVariantsReduced : enterVariants}
      initial="initial"
      animate="animate"
      exit="exit"
      transition={reduceTransition(rowTransition, reduced)}
    >
      <QueueRowShell
        repo={w.repo}
        state="dead"
        ticketKey={w.ticket}
        priority={ticket?.priority ?? 0}
        title={ticket?.title || w.ticket}
        withTopHairline={withTopHairline}
        meta={
          <>
            <PhasePill phase={w.phase} />
            <span style={{ fontFamily: C.mono, fontSize: 11, fontVariantNumeric: "tabular-nums", color: C.fgDim, lineHeight: "18px" }}>
              dead {fmtRuntime(w.runtimeMs)}
            </span>
          </>
        }
      />
    </motion.div>
  );
}

export function DeadStrip({
  workers,
  tickets,
  maxParallel,
}: {
  workers: BoardWorker[];
  tickets: BoardTicket[];
  maxParallel: number;
}) {
  const dead = deadWorkers(workers);
  if (dead.length === 0) return null;
  const infoById = new Map(tickets.map((t) => [t.id, t]));
  return (
    <section style={{ opacity: 0.55 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: C.fgMuted }}>
        Dead / stale <span style={{ color: C.fgDim }}>· {dead.length} — holding no slots</span>
      </div>
      <div style={{ fontSize: 11.5, color: C.fgDim, margin: "2px 0 4px" }}>
        Background jobs that ended without cleanup. They don&apos;t count toward the {maxParallel} slots — listed for forensics until reaped.
      </div>
      <AnimatePresence initial={false}>
        {dead.map((w, i) => (
          <DeadRow key={w.name} w={w} ticket={infoById.get(w.ticket)} withTopHairline={i > 0} />
        ))}
      </AnimatePresence>
    </section>
  );
}
