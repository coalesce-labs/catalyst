import { cn } from "@/lib/utils";
import type { StatusSemantic } from "@/lib/formatters";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  type LucideIcon,
} from "lucide-react";

interface StatusDotProps {
  alive?: boolean;
  className?: string;
}

export function StatusDot({ alive, className }: StatusDotProps) {
  return (
    <span className={cn("relative inline-block h-2 w-2", className)}>
      <span
        className={cn(
          "absolute inset-0 rounded-full",
          alive ? "bg-green shadow-[0_0_6px_theme(colors.green)]" : "bg-[#6b7280]",
        )}
      />
      {alive && (
        <span className="absolute inset-0 rounded-full bg-green animate-live-pulse" />
      )}
    </span>
  );
}

const HEALTH_ICON: Record<string, { icon: LucideIcon; color: string }> = {
  failed: { icon: AlertTriangle, color: "text-red" },
  active: { icon: Activity, color: "text-green" },
  idle: { icon: CheckCircle2, color: "text-muted" },
};

export function HealthIcon({
  failed,
  active,
  size = "h-4 w-4",
}: {
  failed: number;
  active: number;
  size?: string;
}) {
  const key = failed > 0 ? "failed" : active > 0 ? "active" : "idle";
  const { icon: Icon, color } = HEALTH_ICON[key];
  return <Icon className={cn(size, "flex-shrink-0", color)} />;
}

export function ConnectionDot({ status }: { status: string }) {
  return (
    <span
      className={cn("inline-block h-2 w-2 rounded-full", {
        "bg-green shadow-[0_0_6px_theme(colors.green)]": status === "connected",
        "bg-red": status === "reconnecting",
        "bg-[#6b7280]": status === "connecting",
      })}
    />
  );
}
