export type PrBadgeVariant =
  | "merged"
  | "open"
  | "draft"
  | "blocked"
  | "conflict"
  | "unstable"
  | "closed"
  | "unknown";

export interface PrBadgeInput {
  state?: string | null;
  mergeStateStatus?: string | null;
  isDraft?: boolean | null;
}

/**
 * Derive the visual variant for a PR badge from its GitHub-reported state.
 *
 * Precedence (from highest):
 *   MERGED  → merged    (always wins, even if isDraft or blocked somehow)
 *   CLOSED  → closed    (unmerged; draft flag ignored — the PR is dead)
 *   OPEN    → draft     (if isDraft)
 *           → conflict  (DIRTY)
 *           → blocked   (BLOCKED — failing required check or unsatisfied review rule)
 *           → unstable  (UNSTABLE — non-required check is failing)
 *           → open      (CLEAN, BEHIND, HAS_HOOKS, UNKNOWN, undefined)
 *   anything else → unknown
 *
 * Inputs are normalized to upper-case for defensive handling of worker-written
 * signal files that may not normalize casing.
 */
export function derivePrVariant(input: PrBadgeInput): PrBadgeVariant {
  const state = typeof input.state === "string" ? input.state.toUpperCase() : "";
  if (state === "MERGED") return "merged";
  if (state === "CLOSED") return "closed";
  if (state !== "OPEN") return "unknown";

  if (input.isDraft) return "draft";

  const ms =
    typeof input.mergeStateStatus === "string"
      ? input.mergeStateStatus.toUpperCase()
      : "";
  if (ms === "DIRTY") return "conflict";
  if (ms === "BLOCKED") return "blocked";
  if (ms === "UNSTABLE") return "unstable";
  return "open";
}

export interface PrBadgeTheme {
  /** Tailwind class fragments for the filled pill variant. */
  pill: string;
  /** Inline CSS color for accent borders / icons when Tailwind tokens don't cover us. */
  accent: string;
  /** Short human label. */
  label: string;
  /** Whether the variant is an outline/secondary style. */
  outline: boolean;
}

const THEMES: Record<PrBadgeVariant, PrBadgeTheme> = {
  merged: {
    pill: "bg-[#3a2a52] text-[#d4baf5] border border-[#8a63d2]/40",
    accent: "#8a63d2",
    label: "merged",
    outline: false,
  },
  open: {
    pill: "bg-green/18 text-green border border-green/30",
    accent: "var(--color-green)",
    label: "open",
    outline: false,
  },
  draft: {
    pill: "bg-surface-3 text-muted border border-border",
    accent: "var(--color-muted)",
    label: "draft",
    outline: true,
  },
  blocked: {
    pill: "bg-yellow/18 text-yellow border border-yellow/30",
    accent: "var(--color-yellow)",
    label: "blocked",
    outline: false,
  },
  conflict: {
    pill: "bg-red/18 text-red border border-red/30",
    accent: "var(--color-red)",
    label: "conflict",
    outline: false,
  },
  unstable: {
    pill: "bg-yellow/18 text-yellow border border-yellow/30",
    accent: "var(--color-yellow)",
    label: "checks failing",
    outline: false,
  },
  closed: {
    pill: "bg-transparent text-red border border-red/40",
    accent: "var(--color-red)",
    label: "closed",
    outline: true,
  },
  unknown: {
    pill: "bg-surface-3 text-muted border border-border",
    accent: "var(--color-muted)",
    label: "unknown",
    outline: true,
  },
};

export function prBadgeTheme(variant: PrBadgeVariant): PrBadgeTheme {
  return THEMES[variant];
}
