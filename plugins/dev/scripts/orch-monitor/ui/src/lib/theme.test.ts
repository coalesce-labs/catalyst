// theme.test.ts — CTL-1147 appearance preference core tests.
//
// Tests the THREE-way preference layer (system | dark | light) added on top of
// the existing two-state resolved Theme. Pure, DOM-free (bun has none).
// Modelled on lib/brand.test.ts.
//
//   cd plugins/dev/scripts/orch-monitor && bun test src/lib/theme.test.ts
import { describe, it, expect } from "bun:test";
import {
  THEME_PREFERENCES,
  DEFAULT_PREFERENCE,
  readStoredPreference,
  resolveTheme,
  nextPreference,
  applyTheme,
} from "./theme";

describe("CTL-1147 appearance preference core", () => {
  it("THEME_PREFERENCES is exactly [system, dark, light]", () => {
    expect(THEME_PREFERENCES).toEqual(["system", "dark", "light"]);
  });

  it("DEFAULT_PREFERENCE is system (fresh install follows OS)", () => {
    expect(DEFAULT_PREFERENCE).toBe("system");
  });

  it("readStoredPreference accepts system/dark/light, else defaults to system", () => {
    expect(readStoredPreference({ getItem: () => "system" })).toBe("system");
    expect(readStoredPreference({ getItem: () => "dark" })).toBe("dark");
    expect(readStoredPreference({ getItem: () => "light" })).toBe("light");
    expect(readStoredPreference({ getItem: () => "bogus" })).toBe("system");
    expect(readStoredPreference(null)).toBe("system");
  });

  it("resolveTheme: system follows the OS flag; dark/light are explicit", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("light", true)).toBe("light");
  });

  it("nextPreference cycles system → dark → light → system", () => {
    expect(nextPreference("system")).toBe("dark");
    expect(nextPreference("dark")).toBe("light");
    expect(nextPreference("light")).toBe("system");
  });

  it("applyTheme still maps a RESOLVED theme onto the .dark class", () => {
    const added: string[] = [];
    const removed: string[] = [];
    const root = {
      classList: {
        add: (t: string) => added.push(t),
        remove: (t: string) => removed.push(t),
      },
    };
    applyTheme("dark", root);
    expect(added).toContain("dark");
    applyTheme("light", root);
    expect(removed).toContain("dark");
  });
});

// FOUC inline-script contract guard: the shipped index.html boot script must
// handle all three preference states including "system" via matchMedia.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

it("index.html boot script resolves system via matchMedia (FOUC-free)", () => {
  const root = dirname(fileURLToPath(import.meta.url)); // ui/src/lib
  const html = readFileSync(join(root, "../../index.html"), "utf8");
  expect(html).toMatch(/prefers-color-scheme:\s*dark/);
  expect(html).toMatch(/catalyst:theme/);
  // explicit light removes .dark; explicit dark adds it; system defers to matchMedia
  expect(html).toMatch(/=== ?["']light["']/);
});
