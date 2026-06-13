// governance-flags-chip.tsx — CTL-1100 Phase 6 + CTL-1104 Phase 2.
// Renders the 7 governance mode badges. Two modes:
//   • Self-fetch (no props): fetches /api/governance once with capped retry.
//   • Data-driven (snapshot prop): renders from provided props, no fetch.
// Backward-compatible — existing zero-prop consumers are unchanged.
import { useEffect, useState } from "react";
import {
  isGovernanceSnapshot,
  flagTone,
  modeTone,
  GOVERNANCE_FLAG_LABELS,
  type GovernanceSnapshot,
  type GovernanceSnapshotModes,
} from "../../lib/governance-model";

const MAX_RETRIES = 3;

const BOOL_FLAGS = ["beliefsShadow", "diagnostician", "intentsEnforce", "advanceShadowSummary"] as const;
const MODE_FLAGS = ["stallJanitor", "watchdog", "unstuckSweep"] as const;

/** The mode badges JSX — shared between self-fetch and prop-driven paths. */
function ModeBadges({ modes }: { modes: GovernanceSnapshotModes }) {
  return (
    <div className="flex flex-wrap gap-1">
      {BOOL_FLAGS.map((key) => {
        const val = (modes as Record<string, unknown>)[key] as boolean ?? false;
        const tone = flagTone(val);
        return (
          <span
            key={key}
            title={GOVERNANCE_FLAG_LABELS[key]}
            className={`rounded px-1 py-0.5 text-xs font-mono ${tone === "green" ? "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200" : "bg-muted text-muted-foreground"}`}
          >
            {GOVERNANCE_FLAG_LABELS[key] ?? key}
          </span>
        );
      })}
      {MODE_FLAGS.map((key) => {
        const val = ((modes as Record<string, unknown>)[key] as { mode?: string } | undefined)?.mode ?? "off";
        const tone = modeTone(val);
        return (
          <span
            key={key}
            title={`${GOVERNANCE_FLAG_LABELS[key] ?? key}: ${val}`}
            className={`rounded px-1 py-0.5 text-xs font-mono ${tone === "green" ? "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200" : tone === "yellow" ? "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200" : "bg-muted text-muted-foreground"}`}
          >
            {GOVERNANCE_FLAG_LABELS[key] ?? key}:{val}
          </span>
        );
      })}
    </div>
  );
}

export interface GovernanceFlagsChipProps {
  /** When provided, renders from this snapshot without fetching (CTL-1104). */
  snapshot?: GovernanceSnapshotModes | null;
  /** Human-readable age label, e.g. "5s ago". Shown when snapshot is provided. */
  reportedAtLabel?: string;
  /** When true, appends a stale badge (CTL-1104). */
  stale?: boolean;
}

export function GovernanceFlagsChip({ snapshot, reportedAtLabel, stale }: GovernanceFlagsChipProps = {}) {
  // Self-fetch path — only active when no snapshot prop is provided.
  const [fetchedSnapshot, setFetchedSnapshot] = useState<GovernanceSnapshot | null>(null);
  const [retries, setRetries] = useState(0);

  const isPropDriven = snapshot !== undefined;

  useEffect(() => {
    if (isPropDriven) return;
    if (retries > MAX_RETRIES) return;
    let cancelled = false;
    fetch("/api/governance")
      .then((r) => r.json())
      .then((body) => {
        if (cancelled) return;
        if (isGovernanceSnapshot(body)) setFetchedSnapshot(body);
        else setRetries((prev) => prev + 1);
      })
      .catch(() => {
        if (!cancelled) setRetries((prev) => prev + 1);
      });
    return () => { cancelled = true; };
  }, [retries, isPropDriven]);

  // ── Prop-driven path (CTL-1104) ─────────────────────────────────────────
  if (isPropDriven) {
    if (!snapshot) {
      return <span className="text-muted-foreground text-xs">governance —</span>;
    }
    return (
      <div className="flex flex-col gap-1">
        <ModeBadges modes={snapshot} />
        <div className="flex items-center gap-1.5">
          {reportedAtLabel && (
            <span className="text-muted-foreground text-[10px]">{reportedAtLabel}</span>
          )}
          {stale && (
            <span className="rounded bg-amber-100 px-1 py-0.5 text-[10px] font-mono text-amber-700 dark:bg-amber-900 dark:text-amber-200">
              stale
            </span>
          )}
        </div>
      </div>
    );
  }

  // ── Self-fetch path (unchanged CTL-1100 behavior) ────────────────────────
  if (!fetchedSnapshot || !fetchedSnapshot.available) {
    return <span className="text-muted-foreground text-xs">governance —</span>;
  }

  return <ModeBadges modes={fetchedSnapshot} />;
}
