import { cn } from "@/lib/utils";

interface ProjectDotProps {
  size?: number;
  label?: string;
  className?: string;
}

/**
 * CTL-169 — ambient project identity dot. Renders as a filled circle tinted
 * by the nearest `data-project-color` ancestor. When no ancestor scope is
 * active (or the orchestrator has no mapped project), `--project-color`
 * evaluates to `transparent` and the dot disappears — callers don't need
 * to conditionally render it.
 */
export function ProjectDot({ size = 8, label, className }: ProjectDotProps) {
  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn("inline-block shrink-0 rounded-full", className)}
      style={{
        width: size,
        height: size,
        backgroundColor: "var(--project-color)",
      }}
    />
  );
}

/**
 * CTL-169 — 4×16px project identity slab, used in the orch-detail eyebrow.
 * Transparent when no project scope is active.
 */
export function ProjectSlab({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-block shrink-0 rounded-sm", className)}
      style={{
        width: 4,
        height: 16,
        backgroundColor: "var(--project-color)",
      }}
    />
  );
}
