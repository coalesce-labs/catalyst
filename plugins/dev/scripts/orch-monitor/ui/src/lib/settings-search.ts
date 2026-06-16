// settings-search.ts — typed settings route search-param contract (CTL-1153 Phase 5).
//
// PURE module — React-/router-free (identical pattern to root-search.ts) so it
// unit-tests under `bun test` directly. Total + non-throwing: any input yields a
// valid SettingsSearch; an absent or malformed `project` drops to `undefined`.

/** The typed search params for the /settings route. */
export interface SettingsSearch {
  /** The selected project team key (UPPERCASE), or absent for the global sections. */
  project?: string;
}

/**
 * Validate raw URL search into the typed `SettingsSearch`. Keeps only a
 * non-empty string `project`; everything else drops to `undefined` so the URL
 * stays clean when no project is selected. Never throws.
 */
export function validateSettingsSearch(raw: unknown): SettingsSearch {
  const record: Record<string, unknown> =
    typeof raw === "object" && raw !== null
      ? (raw as Record<string, unknown>)
      : {};

  const out: SettingsSearch = {};
  if (typeof record.project === "string" && record.project !== "") {
    out.project = record.project;
  }
  return out;
}
