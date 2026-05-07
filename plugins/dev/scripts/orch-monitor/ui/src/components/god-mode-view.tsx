import { useState, useCallback } from "react";
import { Zap, RefreshCw } from "lucide-react";
import { renderBriefingHtml } from "../lib/briefings";

type ActivityWindow = "30m" | "1h" | "6h";

const WINDOWS: ActivityWindow[] = ["30m", "1h", "6h"];

const WINDOW_LABELS: Record<ActivityWindow, string> = {
  "30m": "30 minutes",
  "1h": "1 hour",
  "6h": "6 hours",
};

interface ActivityBriefingResult {
  enabled: boolean;
  briefing?: string;
  window?: ActivityWindow;
  eventCount?: number;
  strippedCount?: number;
  generatedAt?: string;
  cached?: boolean;
}

export function GodModeView() {
  const [selectedWindow, setSelectedWindow] = useState<ActivityWindow>("30m");
  const [result, setResult] = useState<ActivityBriefingResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generate = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/briefing/activity?window=${selectedWindow}`);
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setResult(await res.json() as ActivityBriefingResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setLoading(false);
    }
  }, [selectedWindow]);

  return (
    <div className="flex flex-col gap-4 p-4 h-full overflow-auto">
      <div className="flex items-center gap-2">
        <Zap className="h-5 w-5 text-accent" />
        <h2 className="text-lg font-semibold">Activity Brief</h2>
        <span className="text-xs text-muted ml-auto">
          AI summary of recent event activity
        </span>
      </div>

      <div className="flex items-center gap-3">
        <span className="text-sm text-muted">Window:</span>
        <div className="flex gap-1">
          {WINDOWS.map((w) => (
            <button
              key={w}
              onClick={() => setSelectedWindow(w)}
              className={[
                "px-3 py-1 rounded text-sm font-medium transition-colors",
                selectedWindow === w
                  ? "bg-accent text-white"
                  : "bg-surface-2 text-muted hover:text-fg",
              ].join(" ")}
            >
              {w}
            </button>
          ))}
        </div>
        <button
          onClick={generate}
          disabled={loading}
          className="flex items-center gap-2 px-4 py-1.5 rounded bg-accent text-white text-sm font-medium disabled:opacity-60 hover:opacity-90 transition-opacity ml-2"
        >
          {loading ? (
            <RefreshCw className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Zap className="h-3.5 w-3.5" />
          )}
          {loading ? "Generating…" : "Generate Brief"}
        </button>
      </div>

      {error && (
        <div className="rounded border border-red/30 bg-red/10 px-3 py-2 text-sm text-red">
          {error}
        </div>
      )}

      {result && !error && (
        <div className="flex flex-col gap-2">
          {!result.enabled ? (
            <div className="rounded border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-sm text-yellow-400">
              AI not configured. Set up a provider in{" "}
              <code className="font-mono">.catalyst/config.json</code> under{" "}
              <code className="font-mono">catalyst.ai</code>.
            </div>
          ) : (
            <>
              <div className="flex items-center gap-3 text-xs text-muted">
                <span>Window: {WINDOW_LABELS[result.window ?? "30m"]}</span>
                <span>·</span>
                <span>{result.eventCount ?? 0} signal events</span>
                <span>·</span>
                <span>{result.strippedCount ?? 0} stripped</span>
                {result.cached && (
                  <>
                    <span>·</span>
                    <span className="text-accent">cached</span>
                  </>
                )}
                {result.generatedAt && (
                  <>
                    <span>·</span>
                    <span>{new Date(result.generatedAt).toLocaleTimeString()}</span>
                  </>
                )}
              </div>
              <div
                className="prose prose-sm prose-invert max-w-none rounded border border-border bg-surface-2 p-4"
                // eslint-disable-next-line react/no-danger
                dangerouslySetInnerHTML={{
                  __html: renderBriefingHtml(result.briefing ?? ""),
                }}
              />
            </>
          )}
        </div>
      )}

      {!result && !loading && !error && (
        <div className="flex flex-col items-center justify-center gap-3 py-16 text-muted">
          <Zap className="h-10 w-10 opacity-30" />
          <p className="text-sm text-center max-w-sm">
            Select a time window and click{" "}
            <span className="font-medium text-fg">Generate Brief</span> to get an
            AI summary of recent event activity.
          </p>
        </div>
      )}
    </div>
  );
}
