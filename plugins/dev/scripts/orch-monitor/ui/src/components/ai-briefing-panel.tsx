import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, RefreshCw, Sparkles, X } from "lucide-react";
import { Panel, SectionLabel } from "./ui/panel";
import { renderBriefingHtml } from "@/lib/briefings";
import { useAiBriefing } from "@/lib/use-ai-briefing";

interface AiBriefingPanelProps {
  orchId: string;
  onClose: () => void;
}

function formatAgo(iso: string | null, now: number): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const seconds = Math.max(0, Math.round((now - t) / 1000));
  if (seconds < 60) return `${String(seconds)}s ago`;
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${String(mins)}m ago`;
  const hours = Math.round(mins / 60);
  return `${String(hours)}h ago`;
}

export function AiBriefingPanel({ orchId, onClose }: AiBriefingPanelProps) {
  const { summary, generatedAt, loading, error, disabled, refresh } =
    useAiBriefing(orchId);
  const kickedOff = useRef<string | null>(null);
  const [now, setNow] = useState<number>(Date.now());

  useEffect(() => {
    if (kickedOff.current !== orchId) {
      kickedOff.current = orchId;
      refresh();
    }
  }, [orchId, refresh]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 10_000);
    return () => {
      clearInterval(id);
    };
  }, []);

  const html = useMemo(
    () => (summary ? renderBriefingHtml(summary) : ""),
    [summary],
  );
  const ago = formatAgo(generatedAt, now);

  return (
    <Panel className="border border-border">
      <div className="flex items-center justify-between border-b border-border px-4 py-2">
        <div className="flex items-center gap-2">
          <Sparkles className="h-3.5 w-3.5 text-accent" />
          <SectionLabel>AI Briefing</SectionLabel>
          {generatedAt && !loading && (
            <span className="text-[11px] text-muted">Last updated {ago}</span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={refresh}
            disabled={loading}
            className="flex items-center gap-1 rounded px-2 py-1 text-[12px] text-muted hover:bg-surface-3 hover:text-fg disabled:opacity-50"
            aria-label="Refresh briefing"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
            />
            Refresh
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-muted hover:bg-surface-3 hover:text-fg"
            aria-label="Close briefing"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <div className="px-4 py-3">
        {loading && !summary && (
          <div className="flex items-center gap-2 text-[13px] text-muted">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Asking Haiku…
          </div>
        )}
        {disabled && !loading && (
          <div className="text-[13px] text-muted">
            AI briefing is not configured. Set{" "}
            <code className="rounded bg-surface-3 px-1">catalyst.ai</code> in{" "}
            <code className="rounded bg-surface-3 px-1">.catalyst/config.json</code>{" "}
            to enable it.
          </div>
        )}
        {error && !loading && !disabled && (
          <div className="text-[13px]">
            <span className="text-red-500">Briefing unavailable.</span>{" "}
            <button
              type="button"
              onClick={refresh}
              className="underline hover:text-fg"
            >
              Retry
            </button>
          </div>
        )}
        {summary && !loading && !disabled && !error && (
          <div
            className="md-content text-[13px]"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )}
      </div>
    </Panel>
  );
}
