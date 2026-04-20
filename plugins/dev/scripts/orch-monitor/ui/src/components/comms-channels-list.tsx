import { cn } from "@/lib/utils";
import { fmtSince } from "@/lib/formatters";
import { StatusDot } from "./ui/status-dot";
import { EmptyState } from "./ui/empty-state";
import { MessageSquare, AlertCircle, Archive } from "lucide-react";
import type { CommsChannelSummary } from "@/lib/types";
import type { CommsStatus } from "@/hooks/use-comms";

interface CommsChannelsListProps {
  channels: CommsChannelSummary[];
  status: CommsStatus;
  selected: string | null;
  onSelect: (name: string) => void;
  onRetry?: () => void;
}

export function CommsChannelsList({
  channels,
  status,
  selected,
  onSelect,
  onRetry,
}: CommsChannelsListProps) {
  if (status === "loading" && channels.length === 0) {
    return (
      <div className="rounded-md border border-border bg-surface-1 p-3 text-[12px] text-muted">
        Loading channels…
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="flex flex-col gap-2 rounded-md border border-red/30 bg-red/5 p-3 text-[12px] text-red">
        <div className="flex items-center gap-1.5 font-medium">
          <AlertCircle className="h-3.5 w-3.5" />
          Failed to load channels
        </div>
        {onRetry && (
          <button
            onClick={onRetry}
            className="self-start rounded border border-red/30 px-2 py-0.5 text-[11px] hover:bg-red/10"
          >
            Retry
          </button>
        )}
      </div>
    );
  }

  if (channels.length === 0) {
    return <EmptyState icon={MessageSquare} message="No channels" />;
  }

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-md border border-border bg-surface-1">
      <div className="border-b border-border px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted">
        Channels
        <span className="ml-1.5 rounded-full bg-surface-3 px-1.5 py-px font-mono text-[9px] tabular-nums">
          {channels.length}
        </span>
      </div>
      <ul className="flex-1 overflow-y-auto">
        {channels.map((c) => (
          <ChannelRow
            key={c.name}
            channel={c}
            isSelected={selected === c.name}
            onClick={() => onSelect(c.name)}
          />
        ))}
      </ul>
    </div>
  );
}

function ChannelRow({
  channel,
  isSelected,
  onClick,
}: {
  channel: CommsChannelSummary;
  isSelected: boolean;
  onClick: () => void;
}) {
  const now = Date.now();
  const lastMs = channel.lastActivity ? Date.parse(channel.lastActivity) : 0;
  const ageSec = lastMs > 0 ? (now - lastMs) / 1000 : null;
  const fresh = ageSec !== null && ageSec < 300;

  return (
    <li>
      <button
        onClick={onClick}
        className={cn(
          "group flex w-full flex-col gap-0.5 border-l-[3px] border-b border-border-subtle px-3 py-2 text-left transition-colors hover:bg-surface-3",
          isSelected
            ? "border-l-accent bg-surface-3/80"
            : "border-l-transparent",
        )}
        aria-label={`Channel ${channel.name}`}
      >
        <div className="flex items-center gap-1.5">
          <StatusDot alive={fresh} />
          <span className="truncate font-mono text-[12px] font-medium text-fg">
            {channel.name}
          </span>
          {channel.archived && (
            <Archive className="h-3 w-3 flex-shrink-0 text-muted" />
          )}
        </div>
        {channel.topic && (
          <div className="truncate text-[11px] text-muted">{channel.topic}</div>
        )}
        <div className="flex items-center gap-2 text-[10px] text-muted">
          <span className="tabular-nums">{channel.participantCount}p</span>
          <span className="tabular-nums">{channel.messageCount}m</span>
          {ageSec !== null && (
            <span className="tabular-nums">{fmtSince(ageSec)} ago</span>
          )}
        </div>
      </button>
    </li>
  );
}
