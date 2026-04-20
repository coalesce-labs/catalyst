import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { fmtSince } from "@/lib/formatters";
import { useCommsStream } from "@/hooks/use-comms";
import { SearchInput } from "./ui/search-input";
import { EmptyState } from "./ui/empty-state";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "./ui/sheet";
import { AgentCard } from "./agent-card";
import { CommsMessageRow } from "./comms-message";
import { MessageSquare, AlertCircle, Archive, RefreshCw } from "lucide-react";
import {
  COMMS_MESSAGE_TYPES,
  type CommsFilter,
  type CommsMessage,
  type CommsMessageType,
} from "@/lib/types";

interface CommsChannelDetailProps {
  name: string;
  filter: CommsFilter;
  onFilterChange: (f: CommsFilter) => void;
}

export function CommsChannelDetail({
  name,
  filter,
  onFilterChange,
}: CommsChannelDetailProps) {
  const { detail, status, error, live, retry } = useCommsStream(name);
  const [openMessage, setOpenMessage] = useState<CommsMessage | null>(null);
  const [search, setSearch] = useState("");

  const messages = detail?.messages ?? [];
  const participants = detail?.participants ?? [];

  const now = Date.now();

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return messages.filter((m) => {
      if (filter.types && !filter.types.has(m.type)) return false;
      if (filter.author && m.from !== filter.author) return false;
      if (q) {
        const hay = (m.body + " " + m.from + " " + m.type).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [messages, filter, search]);

  const toggleType = (t: CommsMessageType) => {
    const current = filter.types ?? new Set(COMMS_MESSAGE_TYPES);
    const next = new Set(current);
    if (next.has(t)) next.delete(t);
    else next.add(t);
    onFilterChange({
      ...filter,
      types: next.size === COMMS_MESSAGE_TYPES.length ? null : next,
    });
  };

  const clearAuthor = () => onFilterChange({ ...filter, author: null });

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-md border border-border bg-surface-1">
      <header className="flex items-center gap-3 border-b border-border px-4 py-3">
        <MessageSquare className="h-4 w-4 text-muted" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate font-mono text-[14px] font-semibold text-fg">
              {name}
            </h2>
            {detail?.archived && (
              <span className="flex items-center gap-1 rounded bg-surface-3 px-1.5 py-px text-[10px] text-muted">
                <Archive className="h-3 w-3" />
                archived
              </span>
            )}
          </div>
          {detail?.topic && (
            <p className="truncate text-[12px] text-muted">{detail.topic}</p>
          )}
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-muted">
          <span
            className={cn(
              "inline-block h-2 w-2 rounded-full",
              live
                ? "bg-green shadow-[0_0_6px_theme(colors.green)]"
                : "bg-[#6b7280]",
            )}
          />
          <span>{live ? "Live" : "Disconnected"}</span>
        </div>
      </header>

      {participants.length > 0 && (
        <div className="flex gap-2 overflow-x-auto border-b border-border bg-surface-2/40 px-4 py-2">
          {participants.map((p) => (
            <AgentCard
              key={p.name}
              participant={p}
              now={now}
              highlight={filter.author === p.name}
            />
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 border-b border-border-subtle px-4 py-2">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Filter messages..."
          className="w-56"
        />
        <div className="flex flex-wrap gap-1">
          {COMMS_MESSAGE_TYPES.map((t) => {
            const active = !filter.types || filter.types.has(t);
            return (
              <button
                key={t}
                onClick={() => toggleType(t)}
                className={cn(
                  "rounded-md px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider transition-colors",
                  active
                    ? "bg-accent/15 text-accent"
                    : "text-muted hover:bg-surface-3 hover:text-fg",
                )}
              >
                {t}
              </button>
            );
          })}
        </div>
        {filter.author && (
          <button
            onClick={clearAuthor}
            className="flex items-center gap-1 rounded-md border border-border bg-surface-3 px-2 py-0.5 text-[10px] text-fg hover:bg-surface-2"
          >
            author: <span className="font-mono">{filter.author}</span>
            <span className="text-muted">×</span>
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {status === "loading" ? (
          <div className="p-6 text-center text-[12px] text-muted">
            Loading channel…
          </div>
        ) : status === "error" ? (
          <div className="flex flex-col items-center justify-center gap-2 py-12 text-red">
            <AlertCircle className="h-5 w-5" />
            <div className="text-[12px]">{error || "stream error"}</div>
            <button
              onClick={retry}
              className="flex items-center gap-1 rounded border border-red/30 px-2 py-0.5 text-[11px] hover:bg-red/10"
            >
              <RefreshCw className="h-3 w-3" /> Retry
            </button>
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={MessageSquare}
            message={
              messages.length === 0
                ? "No messages"
                : "No messages match filters"
            }
          />
        ) : (
          <ul role="list" className="flex flex-col">
            {filtered.map((m) => (
              <li key={m.id}>
                <CommsMessageRow
                  message={m}
                  onOpen={() => setOpenMessage(m)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="border-t border-border bg-surface-2 px-4 py-1.5 text-[10px] text-muted">
        {detail && (
          <>
            {filtered.length}/{detail.total} messages · {participants.length}{" "}
            participant{participants.length === 1 ? "" : "s"}
            {detail.lastActivity && (
              <>
                {" · "}
                last activity{" "}
                {fmtSince(
                  Math.max(
                    0,
                    (Date.now() - Date.parse(detail.lastActivity)) / 1000,
                  ),
                )}{" "}
                ago
              </>
            )}
          </>
        )}
      </div>

      <Sheet
        open={openMessage !== null}
        onOpenChange={(o: boolean) => !o && setOpenMessage(null)}
      >
        <SheetContent side="right" className="bg-surface-1">
          <SheetHeader>
            <SheetTitle>Message</SheetTitle>
          </SheetHeader>
          {openMessage && (
            <div className="flex-1 overflow-auto px-4 pb-4">
              <pre className="whitespace-pre-wrap break-all rounded bg-surface-0 p-3 font-mono text-[11px] text-fg">
                {JSON.stringify(openMessage, null, 2)}
              </pre>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
