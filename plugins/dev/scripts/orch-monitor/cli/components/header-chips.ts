// header-chips.ts — pure layout helper for the HUD Header chip row (CTL-434).
//
// The chip row contains up to three status pills (Groq probe, broker
// interests, plugin version) plus an optional dim decoration after the Groq
// pill. At narrow terminal widths the full-fidelity row overflows and Ink
// wraps the second-line chips below the first, which reads as a duplicate
// status bar.
//
// This helper builds the row at progressively shorter fidelity levels until
// the total width fits within `columns`, dropping decorations and
// abbreviating labels rather than wrapping. The three core pills always
// coexist on one row, even at extreme widths where the result still
// overflows (we accept overflow rather than dropping required information).

import type { BrokerInterestStatus, ProbeStatus } from "../lib/broker-key-health.ts";
import { chipColor, chipLabel, interestChipColor } from "../lib/broker-key-health.ts";

export interface HeaderChipInput {
  /** Terminal columns available for the chip row. */
  columns: number;
  /** Groq probe status; null suppresses the pill entirely. */
  groqStatus: ProbeStatus | null;
  /** True when a Groq key is configured (controls decoration visibility). */
  groqPresent: boolean;
  /** First chars of the configured key (e.g. "gsk_abc"); null suppresses decoration. */
  groqPrefix: string | null;
  /** Source of the configured key (e.g. "env"); shown in decoration parens. */
  groqSource: string | null;
  /** Broker interest pill status. "unknown" suppresses the pill. */
  interestStatus: BrokerInterestStatus;
  /** Broker interest count for the pill label. */
  interestCount: number | null;
  /** Version display string (e.g. "v9.2.0 · local:523b6fe"); null suppresses the pill. */
  versionDisplay: string | null;
  /** Whether the version chip should render in yellow (worktree source). */
  versionIsLocal: boolean;
}

export interface HeaderChipSegment {
  /** Rendered text including any leading separator. */
  text: string;
  /** Ink color name. */
  color: string;
  /** Inverse video flag (used for the degraded broker pill). */
  inverse?: boolean;
  /** Dim flag (used for the Groq decoration). */
  dim?: boolean;
}

export interface HeaderChipLayout {
  segments: HeaderChipSegment[];
  /** Total width including separators. Useful for tests. */
  width: number;
}

const SEP = "  "; // two-space separator between chips, matching the previous inline rendering

type BrokerFidelity = "full" | "short";
type VersionFidelity = "full" | "med" | "min";

function brokerLabel(
  status: BrokerInterestStatus,
  count: number | null,
  fidelity: BrokerFidelity,
): string {
  if (count === null) return "?";
  if (fidelity === "full") {
    if (status === "ok") return `${count} interest${count === 1 ? "" : "s"}`;
    if (status === "startup") return `${count} (starting)`;
    return `${count} interests`;
  }
  if (status === "startup") return `${count} start`;
  return `${count} ints`;
}

function versionLabel(display: string, fidelity: VersionFidelity): string {
  if (fidelity === "full") return display;
  if (fidelity === "med") return display.replace("local:", "");
  const idx = display.indexOf(" · ");
  return idx >= 0 ? display.slice(0, idx) : display;
}

function buildSegments(
  input: HeaderChipInput,
  opts: { includeDeco: boolean; broker: BrokerFidelity; version: VersionFidelity },
): HeaderChipSegment[] {
  const segments: HeaderChipSegment[] = [];
  const showGroq = input.groqStatus !== null;
  const showBroker = input.interestStatus !== "unknown";
  const showVersion = input.versionDisplay !== null;
  let prior = false;

  if (showGroq && input.groqStatus !== null) {
    segments.push({
      text: `[Groq: ${chipLabel(input.groqStatus)}]`,
      color: chipColor(input.groqStatus),
    });
    prior = true;

    if (opts.includeDeco && input.groqPresent && input.groqPrefix !== null) {
      const source = input.groqSource ?? "unknown";
      segments.push({
        text: `${SEP}${input.groqPrefix}... (${source})`,
        color: "white",
        dim: true,
      });
    }
  }

  if (showBroker) {
    const label = brokerLabel(input.interestStatus, input.interestCount, opts.broker);
    segments.push({
      text: `${prior ? SEP : ""}[broker: ${label}]`,
      color: interestChipColor(input.interestStatus),
      inverse: input.interestStatus === "degraded",
    });
    prior = true;
  }

  if (showVersion && input.versionDisplay !== null) {
    const label = versionLabel(input.versionDisplay, opts.version);
    segments.push({
      text: `${prior ? SEP : ""}[${label}]`,
      color: input.versionIsLocal ? "yellow" : "gray",
    });
  }

  return segments;
}

function totalWidth(segments: HeaderChipSegment[]): number {
  let n = 0;
  for (const s of segments) n += s.text.length;
  return n;
}

const FIDELITY_LADDER: Array<{
  includeDeco: boolean;
  broker: BrokerFidelity;
  version: VersionFidelity;
}> = [
  { includeDeco: true, broker: "full", version: "full" },   // L0
  { includeDeco: false, broker: "full", version: "full" },  // L1 — drop decoration
  { includeDeco: false, broker: "short", version: "full" }, // L2 — short broker
  { includeDeco: false, broker: "short", version: "med" },  // L3 — drop "local:" from version
  { includeDeco: false, broker: "short", version: "min" },  // L4 — version only
];

export function layoutHeaderChips(input: HeaderChipInput): HeaderChipLayout {
  let chosen: HeaderChipSegment[] = [];
  let chosenWidth = 0;
  for (const level of FIDELITY_LADDER) {
    chosen = buildSegments(input, level);
    chosenWidth = totalWidth(chosen);
    if (chosenWidth <= input.columns) break;
  }
  return { segments: chosen, width: chosenWidth };
}
