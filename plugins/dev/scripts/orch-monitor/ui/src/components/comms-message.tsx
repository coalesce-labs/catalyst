import { cn } from "@/lib/utils";
import type { CommsMessage, CommsMessageType } from "@/lib/types";

interface CommsMessageProps {
  message: CommsMessage;
  onOpen?: () => void;
}

const TYPE_STYLES: Record<CommsMessageType, string> = {
  proposal: "bg-[#3a2a5a] text-[#c8a8f4]",
  question: "bg-[#1f3a5a] text-[#9ec7f4]",
  answer: "bg-[#1a4a3a] text-[#8af4cc]",
  ack: "bg-surface-3 text-muted",
  info: "bg-surface-3 text-muted",
  attention: "bg-[#5a4a1a] text-[#f4dc8a]",
  done: "bg-[#1a4a3a] text-[#8af4cc]",
};

function fmtClockDT(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return (
    String(d.getHours()).padStart(2, "0") +
    ":" +
    String(d.getMinutes()).padStart(2, "0") +
    ":" +
    String(d.getSeconds()).padStart(2, "0")
  );
}

export function CommsMessageRow({ message, onOpen }: CommsMessageProps) {
  const typeClass = TYPE_STYLES[message.type];
  return (
    <button
      onClick={onOpen}
      className={cn(
        "flex w-full items-baseline gap-2 border-b border-border-subtle px-3 py-1.5 text-left font-mono text-[12px] transition-colors hover:bg-surface-3/40",
        onOpen && "cursor-pointer",
      )}
    >
      <span className="shrink-0 text-muted tabular-nums">
        {fmtClockDT(message.ts)}
      </span>
      <span
        className={cn(
          "shrink-0 rounded px-1.5 py-px text-[10px] uppercase tracking-wider",
          typeClass,
        )}
      >
        {message.type}
      </span>
      <span className="shrink-0 text-muted">{message.from}</span>
      {message.re && (
        <span className="shrink-0 text-[10px] text-muted">↩ {message.re}</span>
      )}
      <span className="min-w-0 flex-1 truncate text-fg">{message.body}</span>
    </button>
  );
}
