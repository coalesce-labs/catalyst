// project-rail.tsx — left column of the settings surface: one row per project (CTL-1153 Phase 5).
import { cn } from "@/lib/utils";
import { NAMED_COLORS } from "@/lib/color-palette";
import { SETTINGS_PENDING_SECTIONS } from "@/lib/project-settings-model";
import type { ProjectRailRow } from "@/lib/project-settings-model";

interface ProjectRailProps {
  rows: ProjectRailRow[];
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
}

export function ProjectRail({ rows, selectedKey, onSelect }: ProjectRailProps) {
  return (
    <nav aria-label="Project settings" className="flex w-44 shrink-0 flex-col gap-0.5">
      <button
        type="button"
        aria-current={selectedKey === null ? "page" : undefined}
        onClick={() => onSelect(null)}
        className={cn(
          "flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors",
          selectedKey === null
            ? "bg-surface-2 font-medium text-fg"
            : "text-muted hover:bg-surface-2 hover:text-fg",
        )}
      >
        General
      </button>

      {rows.map((row) => {
        const selected = selectedKey === row.key;
        const dotColor = row.dotColorName ? NAMED_COLORS[row.dotColorName]?.text : undefined;
        return (
          <button
            key={row.key}
            type="button"
            aria-current={selected ? "page" : undefined}
            onClick={() => onSelect(row.key)}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors",
              selected
                ? "bg-surface-2 font-medium text-fg"
                : "text-muted hover:bg-surface-2 hover:text-fg",
            )}
          >
            {dotColor ? (
              <span
                aria-hidden
                className="size-2 shrink-0 rounded-full"
                style={{ background: dotColor }}
              />
            ) : (
              <span
                aria-hidden
                className="size-2 shrink-0 rounded-full border border-border-subtle"
              />
            )}
            <span className="min-w-0 truncate">{row.label}</span>
          </button>
        );
      })}

      {SETTINGS_PENDING_SECTIONS.length > 0 && (
        <>
          <p className="mt-2 px-3 text-xs font-medium text-muted/60">Configuration</p>
          {SETTINGS_PENDING_SECTIONS.map((section) => {
            const selected = selectedKey === section.key;
            return (
              <button
                key={section.key}
                type="button"
                aria-current={selected ? "page" : undefined}
                onClick={() => onSelect(section.key)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors",
                  selected
                    ? "bg-surface-2 font-medium text-fg"
                    : "text-muted hover:bg-surface-2 hover:text-fg",
                )}
              >
                <span className="min-w-0 truncate">{section.label}</span>
              </button>
            );
          })}
        </>
      )}
    </nav>
  );
}
