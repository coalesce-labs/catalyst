import type { CanonicalEvent } from "../../lib/canonical-event.ts";
import type { HudColumnId } from "../../lib/monitor-config.ts";
import {
  formatTime,
  formatRepo,
  formatIcon,
  formatEvent,
  formatRef,
  formatDetails,
  formatStatus,
  formatOrch,
  formatWorker,
} from "./format.ts";

export interface ColumnDescriptor {
  id: HudColumnId;
  header: string;
  /** Visible by default when no user config is present (follows terminal-width threshold). */
  defaultVisible: boolean;
  /**
   * Minimum terminal width for this column to appear (0 = always).
   * Applies only in no-config mode; overridden by HudColumnConfig.minTerminalWidth.
   */
  minTerminalWidth: number;
  /** Compute the fixed column width in chars. Returns 0 for DETAILS (width computed from remaining space). */
  computeWidth: (terminalCols: number) => number;
  /** Format function for row cells. */
  format: (event: CanonicalEvent) => string;
  /** Ink Text wrap mode. EventRow defaults to "truncate" when absent (CTL-416). */
  wrap?: "truncate" | "wrap";
  /** Render cell text dimmed. */
  dimColor?: boolean;
  /** True for DETAILS — width is computed from remaining terminal space; must be last. */
  flex?: boolean;
}

export const COLUMN_DESCRIPTORS: Record<string, ColumnDescriptor> = {
  status: {
    id: "status",
    header: "S",
    defaultVisible: true,
    minTerminalWidth: 100,
    computeWidth: () => 3,
    format: formatStatus,
    wrap: "truncate",
  },
  time: {
    id: "time",
    header: "TIME",
    defaultVisible: true,
    minTerminalWidth: 0,
    computeWidth: () => 10,
    format: formatTime,
    wrap: "truncate",
  },
  repo: {
    id: "repo",
    header: "REPO",
    defaultVisible: true,
    minTerminalWidth: 0,
    computeWidth: (cols) => Math.min(14, Math.max(10, Math.floor(cols * 0.07))),
    format: formatRepo,
    wrap: "truncate",
  },
  icon: {
    id: "icon",
    // CTL-391: ICON column header is intentionally blank — the icons convey
    // their meaning; a 1-char header label would just clutter the header row.
    header: " ",
    defaultVisible: true,
    minTerminalWidth: 0,
    computeWidth: () => 1,
    format: formatIcon,
    wrap: "truncate",
  },
  event: {
    id: "event",
    header: "EVENT",
    defaultVisible: true,
    minTerminalWidth: 0,
    // CTL-391: EVENT now shows the raw event.name (e.g. "github.pr.merged",
    // "filter.wake.<sessionId>") — longer than legacy friendly labels, so the
    // responsive range grows to 24–40.
    computeWidth: (cols) => Math.min(40, Math.max(24, Math.floor(cols * 0.18))),
    format: formatEvent,
    wrap: "truncate",
  },
  ref: {
    id: "ref",
    header: "REF",
    defaultVisible: true,
    minTerminalWidth: 0,
    computeWidth: (cols) => Math.min(20, Math.max(10, Math.floor(cols * 0.08))),
    format: formatRef,
    wrap: "truncate",
  },
  orch: {
    id: "orch",
    header: "ORCH",
    defaultVisible: true,
    minTerminalWidth: 160,
    // CTL-383: cap tightened from 24 → 18 chars; truncation via wrap="truncate".
    computeWidth: (cols) => Math.min(18, Math.max(16, Math.floor(cols * 0.12))),
    format: formatOrch,
    wrap: "truncate",
  },
  worker: {
    id: "worker",
    header: "WORKER",
    defaultVisible: true,
    minTerminalWidth: 180,
    computeWidth: () => 16,
    format: formatWorker,
    wrap: "truncate",
  },
  details: {
    id: "details",
    header: "DETAILS",
    defaultVisible: true,
    minTerminalWidth: 0,
    // computeWidth returns 0 as a sentinel; resolveColumns computes the real
    // width from remaining terminal space (CTL-395 explicit-width fix).
    computeWidth: () => 0,
    format: formatDetails,
    wrap: "truncate",
    flex: true,
  },
};

/**
 * Default column order — matches the hardcoded sequence in EventRow/Header
 * before CTL-394. Used when no user config is present.
 */
export const DEFAULT_COLUMN_ORDER: HudColumnId[] = [
  "status",
  "time",
  "repo",
  "icon",
  "event",
  "ref",
  "orch",
  "worker",
  "details",
];
