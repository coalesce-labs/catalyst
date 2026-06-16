// pending-section-pane.tsx — empty-state pane for not-yet-wired config tiers (CTL-1212).
import type { PendingSettingsSection } from "@/lib/project-settings-model";

interface PendingSectionPaneProps {
  section: PendingSettingsSection;
}

export function PendingSectionPane({ section }: PendingSectionPaneProps) {
  return (
    <div className="flex flex-1 flex-col gap-4 min-w-0">
      <header>
        <h2 className="text-base font-semibold text-fg">{section.label}</h2>
        <p className="text-xs text-muted">Pending configuration service</p>
      </header>
      <div className="rounded-md border border-border bg-surface-2 px-4 py-3">
        <p className="text-sm text-muted">{section.note}</p>
      </div>
    </div>
  );
}
