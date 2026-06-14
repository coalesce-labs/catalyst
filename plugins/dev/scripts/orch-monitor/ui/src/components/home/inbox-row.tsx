// inbox-row.tsx — CTL-1126: thin adapter for AttentionCard (list variant).
// All row markup (accent bar, glyph, key/title, duration, verb, overflow) lives in
// AttentionCard; this module computes the view-model fields and delegates.
import type { InboxRow as InboxRowModel } from "@/board/home-inbox";
import { modalityFor, escalationTypeFor } from "@/board/attention-card-model";
import type { RespondRowStatus } from "@/hooks/use-respond";
import { AttentionCard } from "./attention-card";

export function InboxRow({
  row,
  selected,
  onSelect,
  now,
  onAct,
  respondStatus = "idle",
}: {
  row: InboxRowModel;
  selected: boolean;
  onSelect: (id: string) => void;
  /** CTL-901 (HOME3): the "current time" the relative duration is measured
   *  against, threaded from the surface so all rows agree on one clock. */
  now: number;
  /** CTL-903 (HOME5): fire the row's ONE bright verb — record the operator's
   *  response + resume the agent. */
  onAct?: (id: string) => void;
  /** CTL-903 (HOME5): the optimistic write status. Defaults to `idle`. */
  respondStatus?: RespondRowStatus;
}) {
  return (
    <AttentionCard
      row={row}
      variant="list"
      modality={modalityFor(row.section)}
      escalationType={escalationTypeFor(row)}
      now={now}
      selected={selected}
      onSelect={onSelect}
      onAct={onAct}
      respondStatus={respondStatus}
    />
  );
}
