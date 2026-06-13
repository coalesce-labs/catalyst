// governance-flags-chip.tsx — CTL-1100 Phase 6: governance mode status chips.
// Fetches /api/governance once with capped retry. Degrades to placeholder when
// absent or unavailable. Modeled on Board.tsx ScopeChip/StatusBadge pattern.
import { useEffect, useState } from "react";
import {
  isGovernanceSnapshot,
  flagTone,
  modeTone,
  GOVERNANCE_FLAG_LABELS,
  type GovernanceSnapshot,
} from "../../lib/governance-model";

const MAX_RETRIES = 3;

export function GovernanceFlagsChip() {
  const [snapshot, setSnapshot] = useState<GovernanceSnapshot | null>(null);
  const [retries, setRetries] = useState(0);

  useEffect(() => {
    if (retries > MAX_RETRIES) return;
    let cancelled = false;
    fetch("/api/governance")
      .then((r) => r.json())
      .then((body) => {
        if (cancelled) return;
        if (isGovernanceSnapshot(body)) setSnapshot(body);
        else setRetries((r) => r + 1);
      })
      .catch(() => {
        if (!cancelled) setRetries((r) => r + 1);
      });
    return () => { cancelled = true; };
  }, [retries]);

  if (!snapshot || !snapshot.available) {
    return <span className="text-muted-foreground text-xs">governance —</span>;
  }

  const boolFlags = ["beliefsShadow", "diagnostician", "intentsEnforce", "advanceShadowSummary"] as const;
  const modeFlags = ["stallJanitor", "watchdog", "unstuckSweep"] as const;

  return (
    <div className="flex flex-wrap gap-1">
      {boolFlags.map((key) => {
        const val = snapshot[key] ?? false;
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
      {modeFlags.map((key) => {
        const val = (snapshot[key] as { mode?: string } | undefined)?.mode ?? "off";
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
