import { cn } from "@/lib/utils";
import { fmtSince } from "@/lib/formatters";
import { StatusDot } from "./ui/status-dot";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip";
import type { CommsParticipant } from "@/lib/types";

interface AgentCardProps {
  participant: CommsParticipant;
  now: number;
  highlight?: boolean;
}

export function AgentCard({ participant, now, highlight }: AgentCardProps) {
  const lastSeenMs = Date.parse(participant.lastSeen);
  const ageMs = Number.isNaN(lastSeenMs) ? Infinity : now - lastSeenMs;
  const stale = ageMs > participant.ttl * 1000;
  const capabilities = (participant.capabilities || "")
    .split(/\s+/)
    .filter(Boolean);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className={cn(
            "flex shrink-0 items-center gap-1.5 rounded-md border px-2.5 py-1.5",
            highlight
              ? "border-accent bg-accent/10"
              : "border-border bg-surface-2",
            stale && "opacity-60",
          )}
        >
          <StatusDot alive={!stale} />
          <span className="font-mono text-[12px] text-fg">
            {participant.name}
          </span>
          {capabilities.length > 0 && (
            <span className="text-[10px] text-muted">
              {capabilities[0]}
              {capabilities.length > 1 ? ` +${capabilities.length - 1}` : ""}
            </span>
          )}
        </div>
      </TooltipTrigger>
      <TooltipContent>
        <div className="space-y-1 text-[11px]">
          <div>
            <span className="text-muted">joined</span>{" "}
            <TimeAgo iso={participant.joined} now={now} />
          </div>
          <div>
            <span className="text-muted">last seen</span>{" "}
            <TimeAgo iso={participant.lastSeen} now={now} />
          </div>
          {capabilities.length > 0 && (
            <div>
              <span className="text-muted">capabilities</span>{" "}
              {capabilities.join(" · ")}
            </div>
          )}
          {participant.orch && (
            <div>
              <span className="text-muted">orch</span> {participant.orch}
            </div>
          )}
          <div>
            <span className="text-muted">ttl</span> {participant.ttl}s
          </div>
          <div>
            <span className="text-muted">status</span> {participant.status}
          </div>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

function TimeAgo({ iso, now }: { iso: string; now: number }) {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return <span>—</span>;
  const secs = Math.max(0, (now - ms) / 1000);
  return <span>{fmtSince(secs)} ago</span>;
}
