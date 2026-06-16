import { useState } from "react";
import { useAtom } from "jotai";
import { useNavigate, useSearch } from "@tanstack/react-router";

import { cn } from "@/lib/utils";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@/components/ui/toggle-group";
import { useSidebar } from "@/components/ui/sidebar";
import { THEME_PREFERENCES, PREFERENCE_LABEL, useTheme, type ThemePreference } from "@/lib/theme";
import { BRANDS, BRAND_LABEL, useBrand } from "@/lib/brand";
import {
  LANDING_SURFACES,
  readLandingSurface,
  writeLandingSurface,
} from "@/lib/prefs";
import { SURFACE_LABEL, type Surface } from "@/lib/surface";
import {
  boardPrefsAtom,
  patchBoardPrefs,
  type BoardPrefs,
} from "@/board/prefs-store";
// Reuse the EXACT option arrays the board's display-options popover renders, so
// the Settings surface and the popover can never drift (the popover's drift-
// guard test already pins each array's key set to its BoardPrefs union).
import {
  DENSITY_OPTIONS,
  GROUP_BY_OPTIONS,
  COLOR_BY_OPTIONS,
  ORDER_OPTIONS,
  LAYOUT_OPTIONS,
} from "@/board/display-options-popover";
import { SWIMLANE_OPTIONS } from "@/board/Swimlane";
import { useBoardSnapshot } from "@/hooks/use-board-snapshot";
import { useRepoIcons } from "@/hooks/use-repo-icons";
import { repoIconPicksAtom, applyIconPick } from "@/lib/repo-icon-picks-store";
import { buildIconPickerRows, resolveIconSectionState } from "@/components/icon-picker-model";
import { NAMED_COLORS } from "@/lib/color-palette";
import {
  repoColorPicksAtom,
  NAMED_COLOR_NAMES,
  applyColorPick,
} from "@/lib/repo-color-picks-store";
// CTL-1153 Phase 5: project rail + per-project settings pane.
import { useProjects } from "@/hooks/use-projects";
import { buildProjectRailRows, resolveSettingsView } from "@/lib/project-settings-model";
import { SETTINGS_PATH } from "@/lib/route-surface";
import { ProjectRail } from "@/components/settings/project-rail";
import { ProjectSettingsPane } from "@/components/settings/project-settings-pane";
import { PendingSectionPane } from "@/components/settings/pending-section-pane";

// settings-surface.tsx — the Settings preferences surface (CTL-911 / SURF3).
// Replaces the footer Settings placeholder (handoff next-step #4). Renders the
// three grouped sections the Gherkin asks for — Board display defaults, Theme,
// and Shell preferences — and each control READS and WRITES the store that
// ALREADY owns that state (no parallel persistence systems):
//   - Board display defaults → the persisted `boardPrefsAtom` (BOARD2 /
//     CTL-906), the SAME atom the board's display-options popover writes.
//   - Theme → `@/lib/theme` (SHELL3 / CTL-893): dark ⇄ light via the `.dark`
//     class on <html>, persisted under `catalyst:theme`. The footer toggle
//     drives the same hook, so the two can never disagree.
//   - Sidebar collapse → the shell's controlled SidebarProvider (`useSidebar`),
//     persisted by lib/sidebar-collapse.ts (SHELL4 / CTL-894).
//   - Landing surface → lib/prefs.ts (the one pref this ticket introduces).
// Persistence is browser-local — there is no settings backend today (the
// ticket's explicit non-goal).

// ── A labelled segmented control bound to a typed enum option set ─────────────
function Field<T extends string>({
  label,
  hint,
  value,
  onChange,
  options,
}: {
  label: string;
  hint?: string;
  value: T;
  onChange: (v: T) => void;
  options: readonly { k: T; label: string }[];
}) {
  return (
    <div className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <div className="min-w-0">
        <div className="text-sm font-medium text-fg">{label}</div>
        {hint && <div className="text-xs text-muted">{hint}</div>}
      </div>
      <ToggleGroup
        type="single"
        value={value}
        // radix ToggleGroup yields "" when the active item is re-clicked; ignore
        // it so the control can never land on an empty value.
        onValueChange={(v) => v && onChange(v as T)}
        variant="outline"
        size="sm"
        className="shrink-0"
      >
        {options.map((o) => (
          <ToggleGroupItem
            key={o.k}
            value={o.k}
            className={cn(
              "text-xs",
              value === o.k ? "text-fg" : "text-muted",
            )}
          >
            {o.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold text-fg">{title}</h2>
        <p className="text-xs text-muted">{description}</p>
      </div>
      <div className="divide-y divide-border px-4">{children}</div>
    </section>
  );
}

export function SettingsSurface() {
  // Board display defaults — the persisted BOARD2 atom (the popover's store).
  const [boardPrefs, setBoardPrefs] = useAtom(boardPrefsAtom);
  const patch = (d: Partial<BoardPrefs>) =>
    setBoardPrefs((p) => patchBoardPrefs(p, d));

  // Appearance — TWO orthogonal axes (CTL-1099/CTL-1147):
  //   MODE  → THREE-WAY preference: system|dark|light (catalyst:theme key).
  //   BRAND → the CTL-1099 brand system (`data-theme` attr + catalyst:brand key).
  const { preference, setPreference } = useTheme();
  const { brand, setBrand } = useBrand();

  // Sidebar collapse — the shell's controlled provider (persisted by the
  // shell's writeSidebarOpen effect, SHELL4).
  const { open: sidebarOpen, setOpen: setSidebarOpen } = useSidebar();

  // Landing surface — read once for the control's initial value, then write
  // through on change (it only takes effect on the next load).
  const [landing, setLanding] = useState<Surface>(readLandingSurface);

  // Project icons — per-repo candidate picker (CTL-997).
  const { payload } = useBoardSnapshot();
  const payloadLoaded = payload != null;
  const repos = payload?.repos ?? [];
  const iconMap = useRepoIcons(repos);
  const [iconPicks, setIconPicks] = useAtom(repoIconPicksAtom);
  const iconPickerRows = buildIconPickerRows(repos, iconMap, iconPicks);
  const iconSectionState = resolveIconSectionState(payloadLoaded, iconPickerRows.length);

  // Project colors — per-repo hue picker (CTL-1027).
  const [colorPicks, setColorPicks] = useAtom(repoColorPicksAtom);
  const colorPickerRows = repos;

  // CTL-1153: project rail — server roster + URL-backed selection.
  const { projects, refetch } = useProjects();
  const navigate = useNavigate();
  const { project: paramKey } = useSearch({ from: SETTINGS_PATH });
  const [selectedKey, setSelectedKey] = useState<string | null>(
    typeof paramKey === "string" && paramKey !== "" ? paramKey : null,
  );

  function selectProject(key: string | null) {
    setSelectedKey(key);
    void navigate({
      to: SETTINGS_PATH,
      search: (prev) => ({ ...prev, project: key ?? undefined }),
    });
  }

  const railRows = buildProjectRailRows(projects);
  const settingsView = resolveSettingsView(projects, selectedKey);

  return (
    <div className="h-full min-h-0 overflow-y-auto bg-surface-1">
      <div className="mx-auto flex w-full max-w-5xl gap-6 px-5 py-6">
        {/* ── Project rail (left column) ─────────────────────────────────────── */}
        <ProjectRail
          rows={railRows}
          selectedKey={selectedKey}
          onSelect={selectProject}
        />

        {/* ── Content (right column) ────────────────────────────────────────── */}
        <div className="flex min-w-0 flex-1 flex-col gap-5">
          {settingsView.kind === "project" ? (
            /* ── Per-project editor pane ──────────────────────────────────── */
            <ProjectSettingsPane
              project={settingsView.project}
              candidates={iconMap[settingsView.project.repo]?.candidates ?? []}
              onSaved={refetch}
            />
          ) : settingsView.kind === "pending" ? (
            /* ── Pending configuration tier pane ─────────────────────────── */
            <PendingSectionPane section={settingsView.section} />
          ) : (
            /* ── Global sections (General) ───────────────────────────────── */
            <>
              <header>
                <h1 className="text-lg font-semibold text-fg">Settings</h1>
                <p className="text-sm text-muted">
                  Choose how the board looks, the theme, and how the shell opens. Saved
                  in this browser — they survive a reload.
                </p>
              </header>

              {/* ── Board display defaults ───────────────────────────────── */}
              <Section
                title="Board display defaults"
                description="The board's persisted display options — the same store its display-options popover writes."
              >
                <Field
                  label="Density"
                  hint="Comfortable shows every property; compact is the dense layout."
                  value={boardPrefs.density}
                  onChange={(v) => patch({ density: v })}
                  options={DENSITY_OPTIONS}
                />
                <Field
                  label="Swimlanes"
                  hint="Group rows by an axis, or keep one combined board."
                  value={boardPrefs.swimlane}
                  onChange={(v) => patch({ swimlane: v })}
                  options={SWIMLANE_OPTIONS}
                />
                <Field
                  label="Column grouping"
                  hint="Columns are the Linear Status states, or the pipeline Phase."
                  value={boardPrefs.groupBy}
                  onChange={(v) => patch({ groupBy: v })}
                  options={GROUP_BY_OPTIONS}
                />
                <Field
                  label="Color by"
                  hint="Which axis drives the card accent color."
                  value={boardPrefs.colorBy}
                  onChange={(v) => patch({ colorBy: v })}
                  options={COLOR_BY_OPTIONS}
                />
                <Field
                  label="Ordering"
                  hint="How cards sort within a column."
                  value={boardPrefs.order}
                  onChange={(v) => patch({ order: v })}
                  options={ORDER_OPTIONS}
                />
                <Field<"show" | "hide">
                  label="Empty columns"
                  hint="Keep empty columns visible so the board shape stays stable."
                  value={boardPrefs.showEmptyColumns ? "show" : "hide"}
                  onChange={(v) => patch({ showEmptyColumns: v === "show" })}
                  options={[
                    { k: "show", label: "Show" },
                    { k: "hide", label: "Hide" },
                  ]}
                />
                <Field
                  label="Layout"
                  hint="Kanban board or a flat list."
                  value={boardPrefs.layout}
                  onChange={(v) => patch({ layout: v })}
                  options={LAYOUT_OPTIONS}
                />
              </Section>

              {/* ── Theme ─────────────────────────────────────────────────── */}
              {/* CTL-1099: two orthogonal axes. "Appearance" = MODE (dark ⇄ light, the
                  SHELL3 `.dark` class). "Theme" = BRAND (Warm ⇄ Slate, the data-theme
                  attribute). Warm is the no-attribute default. */}
              <Section
                title="Theme"
                description="Warm is the default theme; Slate is the cooler graphite alternative. Appearance picks dark or light mode."
              >
                <Field
                  label="Appearance"
                  hint="System follows your OS; Dark/Light pin the mode. The footer toggle writes this same choice."
                  value={preference}
                  onChange={(v) => setPreference(v as ThemePreference)}
                  options={THEME_PREFERENCES.map((p) => ({ k: p, label: PREFERENCE_LABEL[p] }))}
                />
                <Field
                  label="Theme"
                  hint="Warm (terracotta) or Slate (Linear blue/graphite)."
                  value={brand}
                  onChange={(v) => setBrand(v)}
                  options={BRANDS.map((b) => ({ k: b, label: BRAND_LABEL[b] }))}
                />
              </Section>

              {/* ── Shell preferences ─────────────────────────────────────── */}
              <Section
                title="Shell preferences"
                description="How the app frame opens. Collapse state is also driven by [ and the rail."
              >
                <Field<"open" | "collapsed">
                  label="Sidebar"
                  hint="Collapsed is full-bleed focus mode. Restored on reload."
                  value={sidebarOpen ? "open" : "collapsed"}
                  onChange={(v) => setSidebarOpen(v === "open")}
                  options={[
                    { k: "open", label: "Expanded" },
                    { k: "collapsed", label: "Collapsed" },
                  ]}
                />
                <Field
                  label="Default landing surface"
                  hint="Which surface opens first on a fresh load."
                  value={landing}
                  onChange={(v) => {
                    setLanding(v);
                    writeLandingSurface(v);
                  }}
                  options={LANDING_SURFACES.map((s) => ({
                    k: s,
                    label: SURFACE_LABEL[s],
                  }))}
                />
              </Section>

              {/* ── Project icons ─────────────────────────────────────────── */}
              <Section
                title="Project icons"
                description="Pick the crispest detected icon per project, or let Catalyst choose the best (SVG preferred). Saved in this browser."
              >
                {iconSectionState === "loading" ? (
                  <p className="py-3 text-xs text-muted">Detecting project icons…</p>
                ) : iconSectionState === "empty" ? (
                  <p className="py-3 text-xs text-muted">
                    No detectable project icons yet.
                  </p>
                ) : (
                  iconPickerRows.map(({ repo, options }) => {
                    const activeValue =
                      iconPicks[repo] != null ? iconPicks[repo] : "auto";
                    return (
                      <div
                        key={repo}
                        className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6"
                      >
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-fg">{repo}</div>
                        </div>
                        <ToggleGroup
                          type="single"
                          value={activeValue}
                          onValueChange={(v) => setIconPicks((prev) => applyIconPick(prev, repo, v))}
                          variant="outline"
                          size="sm"
                          className="shrink-0"
                        >
                          {options.map((opt) => {
                            const value = opt.path ?? "auto";
                            return (
                              <ToggleGroupItem
                                key={value}
                                value={value}
                                className={cn(
                                  "gap-1 text-xs",
                                  activeValue === value ? "text-fg" : "text-muted",
                                )}
                                title={opt.path ?? "Auto (best)"}
                              >
                                {opt.dataUrl ? (
                                  <img
                                    src={opt.dataUrl}
                                    alt={opt.label}
                                    className="size-4 object-contain"
                                  />
                                ) : null}
                                {opt.label}
                              </ToggleGroupItem>
                            );
                          })}
                        </ToggleGroup>
                      </div>
                    );
                  })
                )}
              </Section>

              {/* ── Project colors ────────────────────────────────────────── */}
              <Section
                title="Project colors"
                description="Tint each project's swimlane rows with a color, or let Catalyst inherit the configured default. Saved in this browser."
              >
                {colorPickerRows.length === 0 ? (
                  <p className="py-3 text-xs text-muted">No projects to color yet.</p>
                ) : (
                  colorPickerRows.map((repo) => {
                    const active = colorPicks[repo] ?? "auto";
                    return (
                      <div
                        key={repo}
                        className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6"
                      >
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-fg">{repo}</div>
                        </div>
                        <ToggleGroup
                          type="single"
                          value={active}
                          onValueChange={(v) => setColorPicks((prev) => applyColorPick(prev, repo, v))}
                          variant="outline"
                          size="sm"
                          className="shrink-0"
                        >
                          <ToggleGroupItem
                            value="auto"
                            className={cn(
                              "text-xs",
                              active === "auto" ? "text-fg" : "text-muted",
                            )}
                            title="Auto (inherit configured default)"
                          >
                            Auto
                          </ToggleGroupItem>
                          {NAMED_COLOR_NAMES.map((name) => (
                            <ToggleGroupItem
                              key={name}
                              value={name}
                              title={name}
                              className={cn(
                                "gap-1 text-xs",
                                active === name ? "text-fg" : "text-muted",
                              )}
                            >
                              <span
                                aria-hidden
                                className="size-3 rounded-full"
                                style={{
                                  background: NAMED_COLORS[name]?.bg,
                                  outline: "1px solid var(--border-subtle)",
                                }}
                              />
                              {name}
                            </ToggleGroupItem>
                          ))}
                        </ToggleGroup>
                      </div>
                    );
                  })
                )}
              </Section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
