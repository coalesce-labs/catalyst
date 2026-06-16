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
    // CTL-1147: the control's options are the three-way THEME_PREFERENCES + PREFERENCE_LABEL pair.
    expect(settingsSrc).toContain("THEME_PREFERENCES");
    expect(settingsSrc).toContain("PREFERENCE_LABEL");
    expect(settingsSrc).toContain("setPreference");
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

  it("data-theme is the brand axis; .dark is the sole MODE axis (CTL-1099 reverses the SURF3⇄SHELL3 single-axis decision)", () => {
    // CTL-1099 REVERSES the prior CTL-911 invariant ("NO parallel data-theme
    // system exists"). There are now TWO orthogonal axes:
    //   - MODE  → the `.dark` class on <html> (catalyst:theme). dark ⇄ light.
    //   - BRAND → the `data-theme` attribute on <html> (catalyst:brand). warm ⇄ slate.
    // So `data-theme` is no longer a forbidden parallel theme system — it is the
    // LEGITIMATE brand mechanism. The two are independent: a single .dark MODE
    // block, plus data-theme="slate" override blocks that ONLY fork the accent
    // (slate-light) / the full surface ramp (slate-dark).
    // The `.dark` MODE mechanism is still present (the one mode flip)…
    expect(cssSrc).toContain(".dark");
    // …and data-theme="slate" is the legitimate brand mechanism in CSS.
    expect(cssSrc).toContain('data-theme="slate"');
    // The surface + the shell both wire the brand hook (useBrand).
    expect(settingsSrc).toContain("useBrand");
    expect(shellSrc).toContain("useBrand");
    // The dead kebab union-strings stay banned (they were never real values).
    expect(settingsSrc).not.toContain("calm-dark");
    expect(settingsSrc).not.toContain("warm-light");
  });
});

// ── CTL-1099: the brand axis must preserve the semantic palette ────────────────
describe("CTL-1099 brand axis preserves the semantic palette", () => {
  const boardTokensSrc = read("board/board-tokens.ts");

  /** Slice every [data-theme="slate"] rule body (balanced braces) out of css. */
  function slateBlocks(): string[] {
    const blocks: string[] = [];
    const re = /\[data-theme="slate"\]\s*\{/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(cssSrc)) !== null) {
      const open = cssSrc.indexOf("{", m.index);
      let depth = 0;
      for (let i = open; i < cssSrc.length; i++) {
        if (cssSrc[i] === "{") depth++;
        else if (cssSrc[i] === "}") {
          depth--;
          if (depth === 0) {
            blocks.push(cssSrc.slice(open, i + 1));
            break;
          }
        }
      }
    }
    return blocks;
  }

  /** Strip CSS comments so a token MENTIONED in prose (e.g. "--chart-* inherit")
   *  never trips the literal declaration scan. */
  const stripCss = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "");

  it("no [data-theme=\"slate\"] block redefines a semantic --color-* or chart slot", () => {
    const blocks = slateBlocks().map(stripCss);
    // Both the slate-light (:root[...]) and slate-dark (.dark[...]) blocks exist.
    expect(blocks.length).toBe(2);
    // A slate block may CONSUME a semantic token (e.g. `--destructive:
    // var(--color-red)` — the base .dark does the same), but must never REDEFINE
    // one. A redefinition is the token immediately followed by `:` at declaration
    // position; a `var(--color-red)` reference never matches `--color-red\s*:`.
    const REDEFINES = (b: string, token: string) =>
      new RegExp(`${token}\\s*:`).test(b);
    for (const b of blocks) {
      expect(REDEFINES(b, "--color-green")).toBe(false);
      expect(REDEFINES(b, "--color-red")).toBe(false);
      expect(REDEFINES(b, "--color-yellow")).toBe(false);
      expect(REDEFINES(b, "--color-live")).toBe(false);
      expect(REDEFINES(b, "--chart-[0-9]")).toBe(false);
    }
  });

  it("the 9 canonical PHASE hexes in board-tokens.ts are untouched by the warm-dark C change", () => {
    const PINNED: Record<string, string> = {
      todo: "#97a3b4",
      triage: "#8492a4",
      research: "#5e9ee8",
      plan: "#a98ee3",
      implement: "#45c08a",
      verify: "#dba14f",
      review: "#cdb84e",
      pr: "#45bcab",
      done: "#788596",
    };
    for (const [phase, hex] of Object.entries(PINNED)) {
      // The phase key's literal hex still appears verbatim in board-tokens.ts.
      expect(boardTokensSrc).toContain(`${phase}: "${hex}"`);
    }
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

// ── CTL-1212: three-tier nav scaffolding ──────────────────────────────────────
describe("CTL-1212 three-tier nav scaffolding", () => {
  it("the surface uses resolveSettingsView for content dispatch", () => {
    expect(settingsSrc).toContain("resolveSettingsView");
  });

  it("the surface renders PendingSectionPane for pending sections", () => {
    expect(settingsSrc).toContain("PendingSectionPane");
  });

  it("the rail imports SETTINGS_PENDING_SECTIONS", () => {
    const railSrc = read("components/settings/project-rail.tsx");
    expect(railSrc).toContain("SETTINGS_PENDING_SECTIONS");
  });
});

// ── CTL-1212: one-click project settings affordance ───────────────────────────
describe("CTL-1212 one-click project settings affordance", () => {
  it("each project header has a one-click settings button wired to goSettings", () => {
    const occurrences = sidebarSrc.match(/goSettings\(repo\)/g) ?? [];
    expect(occurrences.length).toBeGreaterThanOrEqual(2);
  });

  it("the gear stops propagation so it does not toggle the collapsible header", () => {
    expect(sidebarSrc).toMatch(/stopPropagation\(\)/);
    expect(sidebarSrc).toContain('aria-label="Project settings"');
  });

  it("the gear is hover-revealed with group-hover", () => {
    expect(sidebarSrc).toMatch(/group-hover/);
  });
});
