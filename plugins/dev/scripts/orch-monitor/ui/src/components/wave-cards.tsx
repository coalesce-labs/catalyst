import { useState, useMemo } from "react";
import { StatusBadge, StatusPill } from "./ui/badge";
import { SectionLabel } from "./ui/panel";
import { waveDoneCount } from "@/lib/computations";
import type { OrchestratorState } from "@/lib/types";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { FileText, X } from "lucide-react";

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
                isSelected
                  ? "border-accent bg-surface-3"
                  : "border-border bg-surface-3 hover:border-accent/50"
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
