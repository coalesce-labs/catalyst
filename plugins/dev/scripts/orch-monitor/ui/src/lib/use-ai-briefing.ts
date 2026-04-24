import { useCallback, useRef, useState } from "react";

export interface AiBriefingState {
  summary: string | null;
  generatedAt: string | null;
  loading: boolean;
  error: string | null;
  disabled: boolean;
  refresh: () => void;
}

interface BriefingResponse {
  summary?: string;
  generatedAt?: string;
  enabled?: boolean;
  error?: string;
}

function isBriefingResponse(x: unknown): x is BriefingResponse {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

async function fetchBriefing(orchId: string): Promise<{
  ok: true;
  summary: string;
  generatedAt: string;
} | {
  ok: false;
  disabled?: boolean;
  error?: string;
}> {
  const encoded = encodeURIComponent(orchId);
  const resp = await fetch(`/api/briefing/${encoded}`);
  if (!resp.ok) {
    return { ok: false, error: `HTTP ${String(resp.status)}` };
  }
  const raw: unknown = await resp.json();
  if (!isBriefingResponse(raw)) {
    return { ok: false, error: "Invalid response shape" };
  }
  if (raw.enabled === false) {
    return { ok: false, disabled: true };
  }
  if (typeof raw.summary === "string" && typeof raw.generatedAt === "string") {
    return { ok: true, summary: raw.summary, generatedAt: raw.generatedAt };
  }
  return { ok: false, error: raw.error ?? "Missing summary" };
}

export function useAiBriefing(orchId: string | null): AiBriefingState {
  const [summary, setSummary] = useState<string | null>(null);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [disabled, setDisabled] = useState<boolean>(false);
  const activeRequest = useRef<number>(0);

  const refresh = useCallback(() => {
    if (!orchId) return;
    const token = activeRequest.current + 1;
    activeRequest.current = token;
    setLoading(true);
    setError(null);
    void fetchBriefing(orchId).then((result) => {
      if (activeRequest.current !== token) return;
      setLoading(false);
      if (result.ok) {
        setSummary(result.summary);
        setGeneratedAt(result.generatedAt);
        setDisabled(false);
      } else if (result.disabled) {
        setDisabled(true);
        setSummary(null);
        setGeneratedAt(null);
      } else {
        setError(result.error ?? "Briefing unavailable");
      }
    });
  }, [orchId]);

  return { summary, generatedAt, loading, error, disabled, refresh };
}
