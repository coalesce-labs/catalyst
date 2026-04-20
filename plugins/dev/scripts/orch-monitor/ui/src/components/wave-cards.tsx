import { StatusBadge, StatusPill } from "./ui/badge";
import { waveDoneCount } from "@/lib/computations";
import type { OrchestratorState, WorkerState, Wave } from "@/lib/types";
import { derivePrVariant } from "../../../lib/pr-variant";
import { BriefingSheet } from "./briefing-sheet";
import { FileText } from "lucide-react";

type WaveAccent = "merged" | "blocked" | "conflict" | "neutral";

function waveAccent(wave: Wave, workers: Record<string, WorkerState>): WaveAccent {
  const tickets = Array.isArray(wave.tickets) ? wave.tickets : [];
  if (tickets.length === 0) return "neutral";

  let anyBlocked = false;
  let anyConflict = false;
  let allMerged = true;

  for (const t of tickets) {
    const pr = workers[t]?.pr;
    if (!pr) {
      allMerged = false;
      continue;
    }
    const variant = derivePrVariant({
      state: pr.state,
      mergeStateStatus: pr.mergeStateStatus,
      isDraft: pr.isDraft,
    });
    if (variant !== "merged") allMerged = false;
    if (variant === "blocked") anyBlocked = true;
    if (variant === "conflict") anyConflict = true;
  }

  if (allMerged) return "merged";
  if (anyConflict) return "conflict";
  if (anyBlocked) return "blocked";
  return "neutral";
}

const ACCENT_CLASS: Record<WaveAccent, string> = {
  merged: "border-[#8a63d2]/60 bg-[#3a2a52]/25 hover:border-[#8a63d2]",
  blocked: "border-yellow/50 bg-yellow/10 hover:border-yellow",
  conflict: "border-red/50 bg-red/10 hover:border-red",
  neutral: "border-border bg-surface-3 hover:border-accent/50",
};

const ACCENT_SELECTED: Record<WaveAccent, string> = {
  merged: "border-[#8a63d2] bg-[#3a2a52]/35",
  blocked: "border-yellow bg-yellow/15",
  conflict: "border-red bg-red/15",
  neutral: "border-accent bg-surface-3",
};

interface WaveCardsProps {
  orch: OrchestratorState;
  onWaveSelect?: (wave: number | null) => void;
  selectedWave?: number | null;
}

export function WaveCards({
  orch,
  onWaveSelect,
  selectedWave,
}: WaveCardsProps) {
  const waves = Array.isArray(orch.waves) ? orch.waves : [];

  if (!waves.length) return null;

  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(210px,1fr))] gap-2.5 p-3">
      {waves.map((w) => {
        const tickets = Array.isArray(w.tickets) ? w.tickets : [];
        const doneCount = waveDoneCount(w, orch.workers);
        const briefBody = orch.briefings?.[w.wave];
        const hasBrief = typeof briefBody === "string" && briefBody.length > 0;
        const isSelected = selectedWave === w.wave;
        const accent = waveAccent(w, orch.workers);

        return (
          <div key={w.wave} className="relative">
            <button
              onClick={() => onWaveSelect?.(isSelected ? null : w.wave)}
              className={`flex w-full flex-col gap-2 rounded-md border p-3 text-left transition-colors ${
                isSelected ? ACCENT_SELECTED[accent] : ACCENT_CLASS[accent]
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-[13px] font-semibold text-fg">
                  Wave {w.wave}
                </span>
                <StatusBadge status={w.status || "?"} />
              </div>
              <div className="flex flex-wrap gap-1">
                {tickets.map((t) => (
                  <StatusPill
                    key={t}
                    label={t}
                    status={orch.workers[t]?.status || ""}
                  />
                ))}
              </div>
              <div className="flex items-center justify-between text-[11px] text-muted">
                <span>
                  {doneCount}/{tickets.length} merged
                  {w.completedAt &&
                    " · " + new Date(w.completedAt).toLocaleString()}
                </span>
                {hasBrief && <span className="opacity-0">briefing</span>}
              </div>
            </button>
            {hasBrief && (
              <BriefingSheet wave={w.wave} markdown={briefBody}>
                <button
                  type="button"
                  onClick={(e) => e.stopPropagation()}
                  className="absolute bottom-2 right-2 flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-accent transition-colors hover:bg-surface-2"
                  aria-label={`Open Wave ${w.wave} briefing`}
                >
                  <FileText className="h-3 w-3" /> briefing
                </button>
              </BriefingSheet>
            )}
          </div>
        );
      })}
    </div>
  );
}
