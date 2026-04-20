import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CommsChannelDetail,
  CommsChannelSummary,
  CommsMessage,
} from "@/lib/types";

export type CommsStatus = "loading" | "ok" | "empty" | "error";

interface UseCommsChannelsResult {
  channels: CommsChannelSummary[];
  status: CommsStatus;
  error: string | null;
  retry: () => void;
}

export function useCommsChannels(enabled: boolean): UseCommsChannelsResult {
  const [channels, setChannels] = useState<CommsChannelSummary[]>([]);
  const [status, setStatus] = useState<CommsStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const retry = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function refresh() {
      try {
        const resp = await fetch("/api/comms/channels");
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        const data = (await resp.json()) as { channels: CommsChannelSummary[] };
        if (cancelled) return;
        setChannels(data.channels || []);
        setStatus((data.channels || []).length === 0 ? "empty" : "ok");
        setError(null);
      } catch (e) {
        if (cancelled) return;
        setStatus("error");
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) {
          timer = setTimeout(refresh, 5000);
        }
      }
    }

    void refresh();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [enabled, tick]);

  return { channels, status, error, retry };
}

interface UseCommsStreamResult {
  detail: CommsChannelDetail | null;
  status: CommsStatus;
  error: string | null;
  live: boolean;
  retry: () => void;
}

export function useCommsStream(
  channelName: string | null,
): UseCommsStreamResult {
  const [detail, setDetail] = useState<CommsChannelDetail | null>(null);
  const [status, setStatus] = useState<CommsStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [tick, setTick] = useState(0);
  const retry = useCallback(() => setTick((n) => n + 1), []);
  const detailRef = useRef<CommsChannelDetail | null>(null);

  useEffect(() => {
    detailRef.current = detail;
  }, [detail]);

  useEffect(() => {
    if (!channelName) {
      setDetail(null);
      setStatus("loading");
      setError(null);
      setLive(false);
      return;
    }

    let cancelled = false;
    let terminal = false;
    let es: EventSource | null = null;
    let backoff = 500;
    const BACKOFF_MAX = 15000;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    setStatus("loading");
    setError(null);
    setDetail(null);
    detailRef.current = null;

    function connect() {
      if (cancelled) return;
      const url = `/api/comms/channels/${encodeURIComponent(channelName!)}/stream`;
      try {
        es = new EventSource(url);
      } catch (e) {
        setStatus("error");
        setError(e instanceof Error ? e.message : String(e));
        scheduleReconnect();
        return;
      }

      es.addEventListener("open", () => {
        backoff = 500;
        setLive(true);
      });

      es.addEventListener("snapshot", (e) => {
        try {
          const data = JSON.parse(
            (e as MessageEvent<string>).data,
          ) as CommsChannelDetail;
          if (cancelled) return;
          setDetail(data);
          setStatus(data.messages.length === 0 ? "empty" : "ok");
          setError(null);
        } catch (err) {
          console.error("comms snapshot parse failed", err);
        }
      });

      es.addEventListener("message", (e) => {
        try {
          const msg = JSON.parse(
            (e as MessageEvent<string>).data,
          ) as CommsMessage;
          if (cancelled) return;
          const current = detailRef.current;
          if (!current) return;
          if (current.messages.some((m) => m.id === msg.id)) return;
          const nextMessages = [...current.messages, msg];
          const nextDetail: CommsChannelDetail = {
            ...current,
            messages: nextMessages,
            total: current.total + 1,
            lastActivity: msg.ts,
            authors: current.authors.includes(msg.from)
              ? current.authors
              : [...current.authors, msg.from].sort(),
          };
          setDetail(nextDetail);
          setStatus("ok");
        } catch (err) {
          console.error("comms message parse failed", err);
        }
      });

      es.addEventListener("error-event", (e) => {
        try {
          const data = JSON.parse(
            (e as MessageEvent<string>).data,
          ) as { message?: string; error?: string; channel?: string };
          if (cancelled) return;
          if (data.error === "channel-not-found") {
            terminal = true;
            setStatus("error");
            setError(`Channel "${data.channel ?? channelName}" not found`);
            setLive(false);
            try {
              es?.close();
            } catch {
              /* ignore */
            }
            es = null;
            return;
          }
          setStatus("error");
          setError(data.message || "stream error");
        } catch {
          /* ignore */
        }
      });

      es.onerror = () => {
        setLive(false);
        try {
          es?.close();
        } catch {
          /* ignore */
        }
        es = null;
        scheduleReconnect();
      };
    }

    function scheduleReconnect() {
      if (cancelled || terminal) return;
      const delay = backoff;
      backoff = Math.min(BACKOFF_MAX, backoff * 2);
      reconnectTimer = setTimeout(connect, delay);
    }

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try {
        es?.close();
      } catch {
        /* ignore */
      }
    };
  }, [channelName, tick]);

  return { detail, status, error, live, retry };
}
