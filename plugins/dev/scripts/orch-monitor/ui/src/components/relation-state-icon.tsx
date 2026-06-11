// relation-state-icon.tsx — the Linear-style relation STATE ICON (CTL-1003 §B2).
// A 14px inline SVG that mirrors the glyphs in _v3-ref-linear-relations-list.png:
// a dotted ring (backlog), a solid ring (triage/unstarted), a half-filled ring
// (started), a filled check (completed), an X (canceled/duplicate). The mapping
// is pure + total (`stateIconSpec`) so it is unit-testable without a DOM.

import * as React from "react";

/** The icon spec for a Linear workflow state TYPE. */
export interface StateIconSpec {
  kind: "dotted" | "ring" | "partial" | "check" | "x";
  color: string;
}

const MUTED = "#8b93a1";
const STARTED = "#eab308";
const DONE = "#39d07a";
const CANCELED = "#5b626f";

/**
 * Map a Linear workflow state type to its icon spec. Pure + total: an unknown
 * type falls back to a solid ring (the neutral "exists but not started" glyph).
 *
 *   backlog                → dotted ring (muted)
 *   triage | unstarted     → solid ring (muted)
 *   started                → half-pie ring (amber)
 *   completed              → filled check (green)
 *   canceled | duplicate   → filled X (dim)
 */
export function stateIconSpec(type: string): StateIconSpec {
  switch (type) {
    case "backlog":
      return { kind: "dotted", color: MUTED };
    case "triage":
    case "unstarted":
      return { kind: "ring", color: MUTED };
    case "started":
      return { kind: "partial", color: STARTED };
    case "completed":
      return { kind: "check", color: DONE };
    case "canceled":
    case "duplicate":
      return { kind: "x", color: CANCELED };
    default:
      return { kind: "ring", color: MUTED };
  }
}

/** RelationStateIcon — a 14px inline SVG of the resolved state glyph. */
export function RelationStateIcon({
  type,
  size = 14,
}: {
  type: string;
  size?: number;
}) {
  const { kind, color } = stateIconSpec(type);
  const common: React.SVGProps<SVGSVGElement> = {
    width: size,
    height: size,
    viewBox: "0 0 14 14",
    role: "img",
    "aria-label": `${type} state`,
    style: { flex: "0 0 auto" },
  };
  switch (kind) {
    case "dotted":
      return (
        <svg {...common}>
          <circle
            cx="7"
            cy="7"
            r="5"
            fill="none"
            stroke={color}
            strokeWidth="1.6"
            strokeDasharray="2 2"
          />
        </svg>
      );
    case "ring":
      return (
        <svg {...common}>
          <circle cx="7" cy="7" r="5" fill="none" stroke={color} strokeWidth="1.6" />
        </svg>
      );
    case "partial":
      return (
        <svg {...common}>
          <circle cx="7" cy="7" r="5" fill="none" stroke={color} strokeWidth="1.6" />
          {/* half-pie fill: a wedge from 12 o'clock clockwise to 6 o'clock. */}
          <path d="M7 7 L7 2 A5 5 0 0 1 7 12 Z" fill={color} />
        </svg>
      );
    case "check":
      return (
        <svg {...common}>
          <circle cx="7" cy="7" r="6" fill={color} />
          <path
            d="M4.2 7.2 L6.2 9.2 L9.9 4.8"
            fill="none"
            stroke="#0b0d10"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "x":
      return (
        <svg {...common}>
          <circle cx="7" cy="7" r="6" fill={color} />
          <path
            d="M4.6 4.6 L9.4 9.4 M9.4 4.6 L4.6 9.4"
            fill="none"
            stroke="#0b0d10"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </svg>
      );
  }
}
