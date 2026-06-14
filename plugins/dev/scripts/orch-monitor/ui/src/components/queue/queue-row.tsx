// queue-row.tsx — the shared row primitive for the /queue control tower
// (CTL-1015 §3/§4/§5). One calm, hairline-separated row: leading gutter (ordinal
// or color dot or nothing) → project icon → ticket key → priority icon →
// two-line-clamp title → right meta slot. Reused by the dispatch list, the
// holding buckets, and the dead strip so separators/hover/alignment never drift.
import type { ReactNode } from "react";
import { C } from "../../board/board-tokens";
import { EntityMarker } from "../../board/entity-marker";
import { PriorityIcon } from "../../board/Board";
import type { BoardActiveState } from "../../board/types";

const clamp2 = {
  display: "-webkit-box",
  WebkitLineClamp: 2,
  WebkitBoxOrient: "vertical" as const,
  overflow: "hidden",
};

/** Inset hairline between rows: borderSubtle @60%, no bright/white lines. */
export const ROW_HAIRLINE = "1px solid rgba(39,48,57,0.6)";

export function QueueRowShell({
  gutter,
  repo,
  state = null,
  fallback = C.fgDim,
  ticketKey,
  priority,
  title,
  subline,
  meta,
  withTopHairline,
  highlightBg,
  opacity,
  onClick,
}: {
  /** Leading gutter content (ordinal, color dot, or nothing). Fixed-width column. */
  gutter?: ReactNode;
  repo: string | null | undefined;
  state?: BoardActiveState;
  fallback?: string;
  ticketKey: string;
  priority: number;
  title: string;
  /** Optional second meta line under the title (e.g. "blocked by CTL-1, CTL-2"). */
  subline?: ReactNode;
  /** Right-aligned meta cluster (scope chip, age, host…). */
  meta?: ReactNode;
  withTopHairline?: boolean;
  highlightBg?: string;
  opacity?: number;
  onClick?: () => void;
}) {
  return (
    <div
      className="cat-queue-row"
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
        padding: "10px 8px",
        borderRadius: 6,
        borderTop: withTopHairline ? ROW_HAIRLINE : undefined,
        background: highlightBg,
        opacity,
        cursor: onClick ? "pointer" : "default",
      }}
    >
      {/* leading gutter (ordinal / dot / empty) */}
      {gutter !== undefined && gutter}
      {/* project icon — stands alone */}
      <span style={{ lineHeight: "18px", flex: "0 0 auto" }}>
        <EntityMarker repo={repo} state={state} fallback={fallback} size={16} />
      </span>
      {/* ticket key */}
      <span style={{ fontFamily: C.mono, fontSize: 12.5, fontWeight: 600, color: C.blue, lineHeight: "18px", flex: "0 0 auto" }}>
        {ticketKey}
      </span>
      {/* priority icon — AFTER the key, never beside the project icon */}
      <span style={{ lineHeight: "18px", flex: "0 0 auto" }}>
        <PriorityIcon p={priority} />
      </span>
      {/* title (two-line clamp), grows */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12.5, color: C.fg, lineHeight: 1.4, ...clamp2 }}>{title}</div>
        {subline}
      </div>
      {/* right meta */}
      {meta !== undefined && (
        <div style={{ display: "flex", alignItems: "flex-start", gap: 10, flex: "0 0 auto" }}>
          {meta}
        </div>
      )}
    </div>
  );
}
