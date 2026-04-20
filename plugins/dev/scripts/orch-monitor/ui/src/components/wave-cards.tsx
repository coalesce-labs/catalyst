import { useState, useMemo } from "react";
import { StatusBadge, StatusPill } from "./ui/badge";
import { SectionLabel } from "./ui/panel";
import { waveDoneCount } from "@/lib/computations";
import type { OrchestratorState, WorkerState, Wave } from "@/lib/types";
import { derivePrVariant } from "../../../lib/pr-variant";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { FileText, X } from "lucide-react";

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

function BriefingDrawer({
  markdown,
  waveNum,
  onClose,
}: {
  markdown: string;
  waveNum: number;
  onClose: () => void;
}) {
  const html = useMemo(() => {
    try {
      const raw = marked.parse(markdown, {
        gfm: true,
        breaks: false,
      }) as string;
      return DOMPurify.sanitize(raw, { ADD_ATTR: ["target", "rel"] });
    } catch {
      return `<pre>${markdown}</pre>`;
    }
  }, [markdown]);

  return (
    <div className="border-t border-border bg-[#0f1216] px-5 py-4">
      <div className="mb-3 flex items-center justify-between">
        <SectionLabel>Wave {waveNum} briefing</SectionLabel>
        <button
          onClick={onClose}
          className="text-muted transition-colors hover:text-accent"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="md-content" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

export function WaveCards({
  orch,
  onWaveSelect,
  selectedWave,
}: WaveCardsProps) {
  const [briefingWave, setBriefingWave] = useState<number | null>(null);
  const waves = Array.isArray(orch.waves) ? orch.waves : [];

  if (!waves.length) return null;

  const briefing =
    briefingWave != null ? orch.briefings?.[briefingWave] : undefined;

  return (
    <div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(210px,1fr))] gap-2.5 p-3">
        {waves.map((w) => {
          const tickets = Array.isArray(w.tickets) ? w.tickets : [];
          const doneCount = waveDoneCount(w, orch.workers);
          const hasBrief =
            typeof orch.briefings?.[w.wave] === "string" &&
            orch.briefings[w.wave].length > 0;
          const isSelected = selectedWave === w.wave;
          const accent = waveAccent(w, orch.workers);

          return (
            <button
              key={w.wave}
              onClick={() => {
                if (hasBrief) {
                  setBriefingWave(briefingWave === w.wave ? null : w.wave);
                }
                onWaveSelect?.(isSelected ? null : w.wave);
              }}
              className={`flex flex-col gap-2 rounded-md border p-3 text-left transition-colors ${
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
                {hasBrief && (
                  <span className="flex items-center gap-1 text-accent">
                    <FileText className="h-3 w-3" /> briefing
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>

      {briefing && briefingWave != null && (
        <BriefingDrawer
          markdown={briefing}
          waveNum={briefingWave}
          onClose={() => setBriefingWave(null)}
        />
      )}
    </div>
  );
}
