// icon-picker-model.ts — pure view-model builder for the icon picker UI (CTL-997 Phase 4).
// No React, no side effects — fully unit-testable.
import type { RepoIconMap } from "@/hooks/use-repo-icons";
import type { IconCandidate, IconFormat } from "@/lib/repo-icons";

export interface IconPickerOption {
  /** null = "Auto (best)"; a path string = specific candidate. */
  path: string | null;
  /** Human-readable label for the option. */
  label: string;
  /** Data URL for thumbnail rendering (may be null). */
  dataUrl: string | null;
  /** Format of the candidate (undefined for the Auto option). */
  format?: IconFormat;
  /** Whether this option is currently the active selection. */
  active: boolean;
}

export interface IconPickerRow {
  repo: string;
  options: IconPickerOption[];
}

/**
 * Build the view-model rows for the icon picker in Settings.
 * Repos with no candidates are omitted.
 * The Auto option comes first; a null pick means Auto is active.
 */
export function buildIconPickerRows(
  repos: readonly string[],
  iconMap: RepoIconMap,
  picks: Record<string, string>,
): IconPickerRow[] {
  const rows: IconPickerRow[] = [];
  for (const repo of repos) {
    const icon = iconMap[repo];
    if (!icon || icon.candidates.length === 0) continue;

    const activePick = picks[repo] ?? null;
    const autoOpt: IconPickerOption = {
      path: null,
      label: "Auto",
      dataUrl: icon.autoDataUrl,
      active: activePick === null,
    };
    const candidateOpts: IconPickerOption[] = icon.candidates.map(
      (c: IconCandidate) => ({
        path: c.path,
        label: c.format.toUpperCase(),
        dataUrl: c.dataUrl,
        format: c.format,
        active: activePick === c.path,
      }),
    );

    rows.push({ repo, options: [autoOpt, ...candidateOpts] });
  }
  return rows;
}
