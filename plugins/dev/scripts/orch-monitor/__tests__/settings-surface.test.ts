// settings-surface.test.ts — CTL-911 / SURF3 acceptance guards.
//
// Encodes the SURF3 Gherkin scenarios. `bun test` has no DOM, so — matching the
// existing app-shell.test.ts / app-shell-ia.test.ts pattern — the structural
// scenarios are asserted by static source analysis (read the .tsx as text and
// assert the load-bearing wiring), and the pure landing-surface core
// (lib/prefs.ts) is unit-tested directly in prefs.test.ts.
//
// RECONCILIATION INVARIANT (the SURF3 ⇄ SHELL3 theme clash): there is ONE theme
// model — `@/lib/theme`'s "dark"|"light" via the `.dark` class on <html>
// (SHELL3 / CTL-893). The Settings surface reads/writes THROUGH that hook; it
// must never introduce a parallel `data-theme` system. Likewise the Board
// display defaults bind to the EXISTING `boardPrefsAtom` (BOARD2 / CTL-906) —
// the same store the board's display-options popover writes — not a second
// prefs blob.
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SETTINGS_BREADCRUMB, SURFACES, SURFACE_CHORD } from "../ui/src/lib/surface";

const HERE = dirname(fileURLToPath(import.meta.url));
const UI_SRC = join(HERE, "..", "ui", "src");
const read = (rel: string) => readFileSync(join(UI_SRC, rel), "utf8");

const settingsSrc = read("components/settings-surface.tsx");
const shellSrc = read("components/app-shell.tsx");
const sidebarSrc = read("components/app-sidebar.tsx");
const surfaceSrc = read("lib/surface.ts");
const cssSrc = read("app.css");
// CTL-989: Settings is now the /settings ROUTE (mounted by the unified router
// into the AppShell layout's <Outlet/>), not an inset takeover. The router-entry
// wiring lives in app-router.tsx.
const routerSrc = read("app-router.tsx");

// ── Scenario: Settings nav item opens the preferences surface ─────────────────
describe("Settings nav item opens the preferences surface (CTL-911)", () => {
  it("the footer Settings item navigates to the /settings route (CTL-989)", () => {
    // CTL-989: the footer Settings SidebarMenuButton navigates to SETTINGS_PATH
    // (router.navigate) instead of calling a surface-context openSettings method.
    expect(sidebarSrc).toContain("SETTINGS_PATH");
    expect(sidebarSrc).toMatch(/navigate\(\{\s*to:\s*SETTINGS_PATH/);
    // It reflects the route-derived open state as active.
    expect(sidebarSrc).toContain("isActive={settingsOpen}");
  });

  it("the unified router mounts SettingsSurface at the /settings route (CTL-989)", () => {
    // CTL-989: Settings is the /settings route now — the router renders
    // SettingsSurface into the AppShell layout's <Outlet/> (left nav stays),
    // instead of the old `settingsOpen ? <SettingsSurface/> : children` inset
    // takeover. The shell's content slot just renders the routed <Outlet/>, and
    // `settingsOpen` is DERIVED from the route (pathname === "/settings").
    expect(routerSrc).toContain("SettingsSurface");
    expect(routerSrc).toMatch(/path:\s*"\/settings"/);
    expect(shellSrc).toContain("SidebarInset");
    expect(shellSrc).toContain("const settingsOpen = derived === \"settings\"");
  });

  it("the surface presents grouped sections for Board defaults, Theme, and Shell prefs", () => {
    expect(settingsSrc).toContain("Board display defaults");
    expect(settingsSrc).toContain("Theme");
    expect(settingsSrc).toContain("Shell preferences");
  });

  it("Settings is a FOOTER destination, not an OPERATE landing surface", () => {
    // It must NOT be added to the Surface union / SURFACES / SURFACE_CHORD
    // (the nav/palette landing surfaces). It has its own breadcrumb instead.
    // OBS-5 widened the union to the OBSERVE surfaces, so assert settings'
    // EXCLUSION rather than pinning the exact member list.
    expect(SETTINGS_BREADCRUMB).toEqual(["Settings"]);
    expect(surfaceSrc).toContain("SETTINGS_BREADCRUMB");
    expect(SURFACES.map(String)).not.toContain("settings");
    expect(Object.values(SURFACE_CHORD).map(String)).not.toContain("settings");
    // CTL-1025: the `Surface` union + SURFACE_CHORD were extracted into
    // surface-constants.ts (React-/router-free so surface-actions.ts can import
    // them without pulling in @tanstack/react-router); surface.ts re-exports them.
    // Read the union from its new home.
    const constantsSrc = read("lib/surface-constants.ts");
    const unionSrc = constantsSrc.match(/export type Surface =([^;]*);/)?.[1] ?? "";
    expect(unionSrc).toContain('"home"');
    expect(unionSrc).not.toContain('"settings"');
    // The shell shows the Settings breadcrumb when settingsOpen.
    expect(shellSrc).toMatch(/settingsOpen\s*\?\s*SETTINGS_BREADCRUMB/);
  });
});

// ── Scenario: Board display-option defaults persist across reloads ────────────
describe("Board display defaults bind to the EXISTING boardPrefsAtom (CTL-911)", () => {
  it("the surface reads + writes the persisted BOARD2 prefs atom (no second store)", () => {
    expect(settingsSrc).toContain("boardPrefsAtom");
    expect(settingsSrc).toContain("patchBoardPrefs");
    expect(settingsSrc).toContain("@/board/prefs-store");
  });

  it("the option arrays are REUSED from the display-options popover (no drift)", () => {
    // The popover's drift-guard test already pins each array's key set to its
    // BoardPrefs union; Settings importing the same arrays inherits that guard.
    for (const arr of [
      "DENSITY_OPTIONS",
      "GROUP_BY_OPTIONS",
      "COLOR_BY_OPTIONS",
      "ORDER_OPTIONS",
      "LAYOUT_OPTIONS",
    ]) {
      expect(settingsSrc).toContain(arr);
    }
    expect(settingsSrc).toContain("@/board/display-options-popover");
    // The swimlane axis options come from their owner next to the renderer.
    expect(settingsSrc).toContain("SWIMLANE_OPTIONS");
    expect(settingsSrc).toContain("@/board/Swimlane");
  });
});

// ── Scenario: Theme choice persists (Settings OR the footer toggle) ───────────
describe("Theme routes through the ONE theme system, @/lib/theme (CTL-911)", () => {
  it("the Settings theme control reads/writes useTheme() from @/lib/theme", () => {
    expect(settingsSrc).toContain("useTheme");
    expect(settingsSrc).toContain("@/lib/theme");
    // The control's options are the canonical THEMES + THEME_LABEL pair.
    expect(settingsSrc).toContain("THEMES");
    expect(settingsSrc).toContain("THEME_LABEL");
    expect(settingsSrc).toContain("setTheme");
  });

  it("the theme control lives in Settings, not the sidebar footer (CTL-1052)", () => {
    // CTL-1052 §5: the calm-dark ⇄ warm-light toggle moved OUT of the sidebar footer
    // INTO the Settings surface (Theme → Appearance) so the footer keeps ONLY Settings.
    // The Settings surface owns the wiring to the SAME @/lib/theme hook (SHELL3 intact);
    // the sidebar no longer references the theme system at all.
    expect(settingsSrc).toContain("useTheme");
    expect(settingsSrc).toContain("@/lib/theme");
    expect(sidebarSrc).not.toContain("useTheme");
    expect(sidebarSrc).not.toContain("toggleTheme");
  });

  it("NO parallel data-theme system exists (the SURF3⇄SHELL3 clash resolution)", () => {
    // The `.dark`-class mechanism is the one theme model: no data-theme
    // attribute plumbing in the surface, the shell, or the stylesheet.
    expect(settingsSrc).not.toContain("data-theme");
    expect(shellSrc).not.toContain("data-theme");
    expect(cssSrc).not.toContain("data-theme");
    expect(settingsSrc).not.toContain("calm-dark"); // the dead union values
    expect(settingsSrc).not.toContain("warm-light");
    // The `.dark` token block (SHELL3) is still what the theme flips.
    expect(cssSrc).toContain(".dark");
  });
});

// ── Scenario: Shell preferences persist (collapse + landing surface) ──────────
describe("Shell preferences persist (CTL-911)", () => {
  it("the Settings sidebar control drives the shell's controlled provider", () => {
    // useSidebar() exposes the SAME open/setOpen the controlled SidebarProvider
    // owns, so the control, `[`, Cmd/Ctrl+B, and the rail all write the one
    // persisted bit (lib/sidebar-collapse.ts, SHELL4).
    expect(settingsSrc).toContain("useSidebar");
    // The shell still persists collapse through the SHELL4 helper.
    expect(shellSrc).toContain("writeSidebarOpen");
    expect(shellSrc).toContain("onOpenChange");
  });

  it("the landing surface seeds the first screen via the home route's beforeLoad (CTL-989)", () => {
    // CTL-989: the landing pref no longer seeds React surface state — the URL is
    // the source of truth. The home ("/") route's beforeLoad reads the persisted
    // pref and redirects to a non-home landing surface on a fresh load. The
    // Settings WRITE path (lib/prefs#writeLandingSurface) is unchanged.
    expect(routerSrc).toContain("readLandingSurface");
    expect(routerSrc).toMatch(/beforeLoad/);
    expect(routerSrc).toMatch(/redirect\(\{\s*to:\s*surfaceToPath\(pref\)/);
  });

  it("the home-route redirect is guarded against deep-link initial loads (CTL-1059)", () => {
    // The beforeLoad must consult the captured initial pathname so a cold deep-link
    // never bounces a non-home-preference operator to their landing surface.
    expect(routerSrc).toContain("shouldApplyLandingRedirect");
  });

  it("Settings exposes the landing-surface control and writes it through lib/prefs", () => {
    expect(settingsSrc).toContain("writeLandingSurface");
    expect(settingsSrc).toContain("LANDING_SURFACES");
    expect(settingsSrc).toContain("@/lib/prefs");
  });
});

// ── ⌘K reachability ───────────────────────────────────────────────────────────
describe("Settings is reachable from the command palette (CTL-911)", () => {
  it("the palette lists a Settings item wired to openSettings", () => {
    expect(shellSrc).toMatch(/CommandItem\s+value="Settings"\s+onSelect=\{openSettings\}/);
  });
});
