import { cn } from "@/lib/utils";
import type { ConnectionStatus } from "@/lib/types";
import { Wifi, WifiOff } from "lucide-react";

interface ConnectionBannerProps {
  status: ConnectionStatus;
  className?: string;
}

export function ConnectionBanner({ status, className }: ConnectionBannerProps) {
  if (status === "connected") return null;

  const isReconnecting = status === "reconnecting";

  return (
    <div
      className={cn(
        "flex items-center justify-center gap-2 rounded-lg py-2 px-4 text-[13px]",
        isReconnecting
          ? "bg-red/10 border border-red/20 text-red"
          : "bg-yellow/10 border border-yellow/20 text-yellow",
        className,
      )}
    >
      {isReconnecting ? (
        <WifiOff className="h-4 w-4 animate-live-pulse" />
      ) : (
        <Wifi className="h-4 w-4 animate-spin" />
      )}
      <span>
        {isReconnecting
          ? "Connection lost. Reconnecting..."
          : "Connecting to monitor..."}
      </span>
    </div>
  );
}
