// holding-buckets.tsx — "Why work isn't moving" (CTL-1015 §4).
//
// Up to three cause buckets (needs-you / blocked / waiting), each rendered only
// when non-empty; when all are empty a single dim line stands in. Rows reuse the
// shared QueueRowShell minus the ordinal column. Plain data props (CTL-1016).
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
import type { BoardTicket, BoardWorker } from "../../board/types";
import {
  groupHoldingBuckets,
  type HoldingBucket,
  type HoldingBucketItem,
} from "./queue-model";
import { QueueRowShell } from "./queue-row";

const DOT_COLOR: Record<HoldingBucket["kind"], string> = {
  "needs-you": C.yellow,
  blocked: C.red,
  waiting: C.fgDim,
};
const BUCKET_LABEL: Record<HoldingBucket["kind"], string> = {
  "needs-you": "Needs you",
  blocked: "Blocked by dependencies",
  waiting: "Waiting",
};

function ColorDot({ color }: { color: string }) {
  return <span style={{ width: 7, height: 7, borderRadius: "50%", background: color, display: "inline-block", flex: "0 0 auto" }} />;
}

function BucketRow({
  item,
  withTopHairline,
  onOpenTicket,
}: {
  item: HoldingBucketItem;
  withTopHairline: boolean;
  onOpenTicket?: (key: string) => void;
}) {
  const reduced = useReducedMotion();
  const wrap = (children: React.ReactNode) => (
    <motion.div
      variants={reduced ? enterVariantsReduced : enterVariants}
      initial="initial"
      animate="animate"
      exit="exit"
      transition={reduceTransition(rowTransition, reduced)}
    >
      {children}
    </motion.div>
  );

  if (item.kind === "worker") {
    const w: BoardWorker = item.worker;
    return wrap(
      <QueueRowShell
        repo={w.repo}
        state={w.activeState}
        ticketKey={w.ticket}
        priority={0}
        title={w.ticket}
        withTopHairline={withTopHairline}
        onClick={onOpenTicket ? () => onOpenTicket(w.ticket) : undefined}
        meta={
          item.slot != null ? (
            <span style={{ fontFamily: C.mono, fontSize: 11, color: C.fgDim, lineHeight: "18px" }}>slot {item.slot}</span>
          ) : undefined
        }
      />,
    );
  }

  const t: BoardTicket = item.ticket;
  const blockers = (t.blockers ?? []).filter(Boolean);
  return wrap(
    <QueueRowShell
      repo={t.repo}
      ticketKey={t.id}
      priority={t.priority}
      title={t.title}
      withTopHairline={withTopHairline}
      onClick={onOpenTicket ? () => onOpenTicket(t.id) : undefined}
      subline={
        blockers.length > 0 ? (
          <div style={{ fontSize: 11, color: C.redSoft, fontFamily: C.mono, marginTop: 2 }}>
            blocked by {blockers.join(", ")}
          </div>
        ) : undefined
      }
      meta={
        <ScopeChip scope={t.scope} estimate={t.estimate} estimateDisplay={t.estimateDisplay} />
      }
    />,
  );
}

function Bucket({ bucket, onOpenTicket }: { bucket: HoldingBucket; onOpenTicket?: (key: string) => void }) {
  if (bucket.items.length === 0) return null;
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "0 8px 2px" }}>
        <ColorDot color={DOT_COLOR[bucket.kind]} />
        <span style={{ fontSize: 12, fontWeight: 600, color: C.fgMuted }}>{BUCKET_LABEL[bucket.kind]}</span>
        <span style={{ fontSize: 12, color: C.fgDim }}>· {bucket.items.length}</span>
      </div>
      <AnimatePresence initial={false}>
        {bucket.items.map((item, i) => (
          <BucketRow
            key={item.kind === "worker" ? `w-${item.worker.name}` : `t-${item.ticket.id}`}
            item={item}
            withTopHairline={i > 0}
            onOpenTicket={onOpenTicket}
          />
        ))}
      </AnimatePresence>
    </div>
  );
}

export function HoldingBuckets({
  tickets,
  workers,
  maxParallel,
  onOpenTicket,
}: {
  tickets: BoardTicket[];
  workers: BoardWorker[];
  maxParallel: number;
  onOpenTicket?: (key: string) => void;
}) {
  const buckets = groupHoldingBuckets(tickets, workers, maxParallel);
  return (
    <section>
      <div style={{ fontSize: 13, fontWeight: 600, color: C.fg, marginBottom: 2 }}>Why work isn&apos;t moving</div>
      {buckets.allEmpty ? (
        <div style={{ fontSize: 12, color: C.fgDim, padding: "8px 8px 0" }}>
          Nothing is blocked or waiting on you.
        </div>
      ) : (
        <>
          <Bucket bucket={buckets.needsYou} onOpenTicket={onOpenTicket} />
          <Bucket bucket={buckets.blocked} onOpenTicket={onOpenTicket} />
          <Bucket bucket={buckets.waiting} onOpenTicket={onOpenTicket} />
        </>
      )}
    </section>
  );
}
