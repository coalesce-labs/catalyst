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
  stalled: C.yellow,
  blocked: C.red,
  waiting: C.fgDim,
};
const BUCKET_LABEL: Record<HoldingBucket["kind"], string> = {
  "needs-you": "Needs you",
  stalled: "Stalled — gave up",
  blocked: "Blocked by dependencies",
  waiting: "Held — awaiting capacity",
};

function ColorDot({ color }: { color: string }) {
  return <span style={{ width: 7, height: 7, borderRadius: "50%", background: color, display: "inline-block", flex: "0 0 auto" }} />;
}

function BucketRow({
  item,
  withTopHairline,
  onOpenTicket,
  titleByTicket,
}: {
  item: HoldingBucketItem;
  withTopHairline: boolean;
  onOpenTicket?: (key: string) => void;
  /** CTL-1041: resolve a worker row's ticket TITLE (the read-model's BoardTicket
   *  carries it) so the row leads with the title, not the bare ticket key. */
  titleByTicket: Map<string, string>;
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
        title={titleByTicket.get(w.ticket) || w.ticket}
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
  const stalledLine =
    t.status === "stalled" ? (
      <div style={{ fontSize: 11, color: C.yellowSoft, fontFamily: C.mono, marginTop: 2 }}>
        gave up — {t.failureReason || "unknown reason"}
      </div>
    ) : undefined;
  return wrap(
    <QueueRowShell
      repo={t.repo}
      ticketKey={t.id}
      priority={t.priority}
      title={t.title}
      withTopHairline={withTopHairline}
      onClick={onOpenTicket ? () => onOpenTicket(t.id) : undefined}
      subline={
        stalledLine ??
        (blockers.length > 0 ? (
          <div style={{ fontSize: 11, color: C.redSoft, fontFamily: C.mono, marginTop: 2 }}>
            blocked by {blockers.join(", ")}
          </div>
        ) : undefined)
      }
      meta={
        <ScopeChip scope={t.scope} estimate={t.estimate} estimateDisplay={t.estimateDisplay} />
      }
    />,
  );
}

function Bucket({
  bucket,
  onOpenTicket,
  titleByTicket,
}: {
  bucket: HoldingBucket;
  onOpenTicket?: (key: string) => void;
  titleByTicket: Map<string, string>;
}) {
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
            titleByTicket={titleByTicket}
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
  // CTL-1041: worker rows carry only a ticket key; resolve the ticket TITLE from
  // the same read-model BoardTicket[] so every holding row leads with the title.
  const titleByTicket = new Map(tickets.map((t) => [t.id, t.title]));
  return (
    <section>
      <div style={{ fontSize: 13, fontWeight: 600, color: C.fg, marginBottom: 2 }}>Why work isn&apos;t moving</div>
      {buckets.allEmpty ? (
        <div style={{ fontSize: 12, color: C.fgDim, padding: "8px 8px 0" }}>
          Nothing is blocked or waiting on you.
        </div>
      ) : (
        <>
          <Bucket bucket={buckets.needsYou} onOpenTicket={onOpenTicket} titleByTicket={titleByTicket} />
          <Bucket bucket={buckets.stalled} onOpenTicket={onOpenTicket} titleByTicket={titleByTicket} />
          <Bucket bucket={buckets.blocked} onOpenTicket={onOpenTicket} titleByTicket={titleByTicket} />
          <Bucket bucket={buckets.waiting} onOpenTicket={onOpenTicket} titleByTicket={titleByTicket} />
        </>
      )}
    </section>
  );
}
