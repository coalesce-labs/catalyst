/**
 * CTL-353: Nerd Font detection for HUD status glyphs.
 *
 * The CTL-351 STATUS column moved from width 2 → 3 to accommodate ⏳ (U+23F3),
 * but ⏳ still renders jaggedly because its East_Asian_Width is N while its
 * Emoji_Presentation is Yes — terminals disagree on whether to give it 1 or 2
 * cells. The other status glyphs (✓ ✗ · !) are stable single-cell.
 *
 * Fix: when a Nerd Font is installed, render in-progress as a Private Use
 * Area icon (U+F252 nf-fa-hourglass_half) which is guaranteed single-cell in
 * any monospaced font that includes the Nerd Fonts patch. Otherwise fall back
 * to "…" (U+2026 horizontal ellipsis), also guaranteed single-cell.
 *
 * Detection precedence:
 *   1. CATALYST_NERD_FONT=1|0|true|false env override (CI / explicit user pref)
 *   2. fc-list output containing "Nerd Font" (fontconfig — most reliable, works
 *      on macOS via brew install fontconfig)
 *   3. ~/Library/Fonts and /Library/Fonts on darwin (fallback when fontconfig
 *      isn't installed)
 *   4. /usr/share/fonts and /usr/local/share/fonts on linux (rare fallback)
 *
 * Detection runs once at module load; the result is cached in a module-level
 * variable so EventRow's per-row formatStatus call is a single property read.
 */

import { execSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface NerdFontDetection {
  detected: boolean;
  source: "env" | "fc-list" | "darwin-fonts-dir" | "linux-fonts-dir" | "none";
  // Human-readable hint for the startup log. e.g. "Hack Nerd Font Mono" or
  // "set CATALYST_NERD_FONT=1 to force enable" — never null so the caller
  // can log unconditionally.
  hint: string;
}

// CTL-353: U+F252 is nf-fa-hourglass_half — BMP, single-cell, semantically
// matches ⏳. PUA codepoints are only meaningful when the terminal font is a
// Nerd Font, so we always pair this with a detection check.
export const NERD_FONT_IN_PROGRESS = "";

// Single-cell ellipsis fallback (East_Asian_Width=N, Emoji_Presentation=No, so
// every terminal gives it exactly 1 cell).
export const FALLBACK_IN_PROGRESS = "…";

function readEnvOverride(): boolean | null {
  const raw = process.env.CATALYST_NERD_FONT;
  if (raw === undefined || raw === "") return null;
  const norm = raw.trim().toLowerCase();
  if (norm === "1" || norm === "true" || norm === "yes" || norm === "on") return true;
  if (norm === "0" || norm === "false" || norm === "no" || norm === "off") return false;
  return null;
}

function probeFcList(): { hit: boolean; firstMatch?: string } {
  try {
    const out = execSync("fc-list 2>/dev/null", {
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const lines = out.split("\n");
    const match = lines.find((line) => /nerd font/i.test(line));
    if (match) {
      const family = match.split(":")[1]?.trim() ?? "Nerd Font";
      return { hit: true, firstMatch: family };
    }
    return { hit: false };
  } catch {
    return { hit: false };
  }
}

function probeFontsDirs(dirs: string[]): { hit: boolean; firstMatch?: string } {
  for (const dir of dirs) {
    try {
      const files = readdirSync(dir);
      const match = files.find((f) => /nerd ?font/i.test(f));
      if (match) return { hit: true, firstMatch: match };
    } catch {
      // Directory doesn't exist or isn't readable — try the next one.
    }
  }
  return { hit: false };
}

function runDetection(): NerdFontDetection {
  const override = readEnvOverride();
  if (override !== null) {
    return {
      detected: override,
      source: "env",
      hint: `CATALYST_NERD_FONT=${override ? "1" : "0"}`,
    };
  }

  const fc = probeFcList();
  if (fc.hit) {
    return { detected: true, source: "fc-list", hint: fc.firstMatch ?? "Nerd Font (fc-list)" };
  }

  if (process.platform === "darwin") {
    const userFonts = join(homedir(), "Library", "Fonts");
    const dir = probeFontsDirs([userFonts, "/Library/Fonts"]);
    if (dir.hit) {
      return { detected: true, source: "darwin-fonts-dir", hint: dir.firstMatch ?? "Nerd Font" };
    }
  } else if (process.platform === "linux") {
    const userFonts = join(homedir(), ".local", "share", "fonts");
    const dir = probeFontsDirs([userFonts, "/usr/share/fonts", "/usr/local/share/fonts"]);
    if (dir.hit) {
      return { detected: true, source: "linux-fonts-dir", hint: dir.firstMatch ?? "Nerd Font" };
    }
  }

  return {
    detected: false,
    source: "none",
    hint: "no Nerd Font detected — set CATALYST_NERD_FONT=1 to override or install via plugins/dev/scripts/install-nerd-fonts.sh",
  };
}

let cached: NerdFontDetection | null = null;

/** Cached detection. First call probes the system; subsequent calls return the cached result. */
export function detectNerdFont(): NerdFontDetection {
  if (cached === null) cached = runDetection();
  return cached;
}

/** Test-only: reset the cache so unit tests can exercise the env-override path repeatedly. */
export function _resetNerdFontCacheForTesting(): void {
  cached = null;
}

/** Returns the in-progress glyph appropriate for the current terminal/font. */
export function inProgressGlyph(): string {
  return detectNerdFont().detected ? NERD_FONT_IN_PROGRESS : FALLBACK_IN_PROGRESS;
}

// CTL-355: SOURCE column icon prefixes. Keys match the strings formatSource()
// returns (or a known prefix of them — see sourceIcon() for the matching
// logic). All glyphs are BMP single-cell Nerd Font codepoints so they render
// in one terminal cell next to the source label.
//
// CTL-358: stay inside the Font Awesome 4 BMP block (U+F000-F2E0) so glyphs
// are stable across Nerd Fonts v2 and v3. The v3 patcher moved Material
// Design icons (MDI) from BMP U+F500-FD46 to the supplementary plane
// U+F0001-F1AF7 and repurposed the old codepoints — earlier MDI picks here
// (nf-md-robot at F544, nf-md-arrange_send_to_back at F4FF) rendered as
// arrow / silhouette glyphs in Hack Nerd Font (the current brew cask, v3).
// Linear has no dedicated brand glyph in Nerd Fonts; the ticket icon is the
// closest semantic match. Catalyst uses cogs (multiple gears) since
// orchestration of many workers is the core idea.
//
// PUA glyphs are written as \u{…} escapes so the source file survives
// editor / clipboard round-trips that occasionally strip non-BMP-ish chars.
const SOURCE_ICONS: Record<string, string> = {
  github: "\u{F09B}",     // nf-fa-github
  linear: "\u{F145}",     // nf-fa-ticket — closest semantic match (no Linear logo in NF)
  broker: "\u{F0E7}",     // nf-fa-bolt — broker = wake router
  catalyst: "\u{F085}",   // nf-fa-cogs — orchestrator coordinates many workers
  system: "\u{F013}",     // nf-fa-cog — generic system events
  comms: "\u{F086}",      // nf-fa-comments — agent comms channel
  filter: "\u{F0B0}",     // nf-fa-filter — legacy filter source
  legacy: "\u{F128}",     // nf-fa-question — unknown / pre-canonical events
};

/**
 * Returns a 2-char "icon + space" prefix for the given source label when a
 * Nerd Font is detected, else "" so the label renders bare.
 *
 * Matches by exact label first, then by prefix family ("orch-*" → catalyst,
 * "CTL-*" / "ADV-*" / ticket-shaped → linear ticket). Unknown sources fall
 * through to the system cog so every row has some icon when Nerd Font is on.
 */
export function sourceIcon(source: string): string {
  if (!detectNerdFont().detected) return "";
  const exact = SOURCE_ICONS[source];
  if (exact) return `${exact} `;
  // Orchestrator-derived sources (e.g. "orch-ctl-352-354-2026-05-12" or
  // "orch-ctl-352-354-2026-05-12/CTL-354") show the catalyst robot.
  if (source.startsWith("orch-") || source.includes("/")) {
    return `${SOURCE_ICONS.catalyst} `;
  }
  // Anything else (worker tickets like CTL-352 used as comms source) gets the
  // generic system cog rather than no icon at all — keeps the column aligned.
  return `${SOURCE_ICONS.system} `;
}

// CTL-355: U+F407 nf-cod-git_pull_request — BMP, single-cell. Replaces "#"
// before PR numbers in the REF column when a Nerd Font is detected.
//
// CTL-358: prPrefix() returns the full prefix (including a trailing space
// when Nerd Font is detected, so the glyph and number don't visually fuse).
// The fallback "#" stays bare since "#501" is the conventional shape.
export const NERD_FONT_PR_PREFIX = "\u{F407}";
export const FALLBACK_PR_PREFIX = "#";

/**
 * Returns the PR-number prefix for the REF column —
 *   "{glyph} " when Nerd Font is detected (e.g. " 501")
 *   "#"       otherwise (e.g. "#501")
 */
export function prPrefix(): string {
  return detectNerdFont().detected
    ? `${NERD_FONT_PR_PREFIX} `
    : FALLBACK_PR_PREFIX;
}
