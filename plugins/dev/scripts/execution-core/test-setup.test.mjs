// test-setup.test.mjs — CTL-810 suite-hermeticity tripwire.
//
// The preload (test-setup.mjs, wired via bunfig [test].preload) must pin
// CATALYST_DIR to a fresh per-run temp dir BEFORE any test module loads, so a
// test (or code under test reaching a default appendEvent/emitReapIntent seam,
// e.g. recovery.test.mjs reclaim branches B/C) can never append to the REAL
// ~/catalyst/events/YYYY-MM.jsonl. Evidence: 194,544 of 282,627 prod log lines
// (69%) were CTL-9/bg-9 test-fixture pollution on 2026-06-06.
//
// Asserts key off CATALYST_HERMETIC_DIR — the preload's stable record of the
// pinned value — because sibling test files legitimately overwrite and restore
// CATALYST_DIR mid-suite; the record is the invariant, the live var is not.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import { getEventLogPath } from "./config.mjs";
import { claudeConfigDir } from "./doctor.mjs";
import { emitReapIntent, REAP_INTENT_TYPES } from "./reap-intent.mjs";

const realCatalystDir = resolve(homedir(), "catalyst");

describe("CTL-810: hermetic CATALYST_DIR preload", () => {
  test("preload pinned CATALYST_DIR to a per-run temp dir and recorded it", () => {
    const pinned = process.env.CATALYST_HERMETIC_DIR;
    expect(pinned).toBeDefined();
    // mkdtempSync names the dir with our prefix — guards against the pin being
    // repointed somewhere meaningful (like the real ~/catalyst).
    expect(pinned).toContain("catalyst-hermetic-");
    // It must live under the OS temp root, never under the real ~/catalyst.
    expect(resolve(pinned).startsWith(realCatalystDir + sep)).toBe(false);
    expect(resolve(pinned)).not.toBe(realCatalystDir);
    expect(resolve(pinned).includes(`${sep}T${sep}`) || resolve(pinned).startsWith(resolve(tmpdir()))).toBe(true);
    // The dir actually exists, so path resolution inside code under test works.
    expect(existsSync(pinned)).toBe(true);
  });

  test("CATALYST_DIR is never the real ~/catalyst when this file runs", () => {
    // Bun runs every *.test.mjs in ONE shared process with a shared env, and
    // sibling files legitimately repoint CATALYST_DIR to their own scratch
    // (some without restoring). So equality-to-the-pin can't be asserted here;
    // the load-bearing invariant is weaker but real: CATALYST_DIR must NEVER
    // be unset back to (or repointed at) the ~/catalyst fallback — the preload
    // seeded it, and the save/restore pattern restores the seed, not undefined.
    expect(process.env.CATALYST_DIR).toBeDefined();
    expect(resolve(process.env.CATALYST_DIR)).not.toBe(realCatalystDir);
    expect(resolve(process.env.CATALYST_DIR).startsWith(realCatalystDir + sep)).toBe(false);
  });

  test("getEventLogPath() resolves outside the real ~/catalyst", () => {
    const p = resolve(getEventLogPath());
    expect(p.startsWith(realCatalystDir + sep)).toBe(false);
  });

  test("functional: the polluter seam writes under the hermetic dir end-to-end", async () => {
    // The exact seam that polluted the prod log (emitReapIntent → default
    // getEventLogPath → mkdir + append) must land its line under the pinned
    // hermetic dir. Pin CATALYST_DIR back to the recorded value for the
    // duration (a sibling may have repointed it), emit a uniquely-marked
    // intent, and read the line back from the hermetic events file.
    const pinned = process.env.CATALYST_HERMETIC_DIR;
    const prev = process.env.CATALYST_DIR;
    process.env.CATALYST_DIR = pinned;
    try {
      const marker = `tripwire-${process.pid}`;
      const ok = await emitReapIntent(REAP_INTENT_TYPES[0], {
        ticket: "CTL-810-TRIPWIRE",
        bgJobId: marker,
      });
      expect(ok).toBe(true);
      const eventsDir = join(pinned, "events");
      const lines = readdirSync(eventsDir)
        .map((f) => readFileSync(join(eventsDir, f), "utf8"))
        .join("");
      expect(lines).toContain(marker);
    } finally {
      process.env.CATALYST_DIR = prev;
    }
  });
});

// CAT-154: CLAUDE_CONFIG_DIR is the (single) input to claudeConfigDir() (doctor.mjs:5004), which
// resolves where the skills-dir check looks for ~/.claude/skills/catalyst-* symlinks. Unpinned, a
// developer's real install grades PASS/WARN and a clean CI runner grades FAIL — the exact
// host-divergence class the CATALYST_LAYER2_CONFIG_FILE pin above exists to prevent.
describe("CAT-154: hermetic CLAUDE_CONFIG_DIR preload", () => {
  // Assert against the preload's RECORD, not the live var — the same rule this file's header
  // states for CATALYST_DIR/CATALYST_HERMETIC_DIR. bun runs the whole suite in one process, so a
  // sibling test that legitimately overwrites and restores CLAUDE_CONFIG_DIR mid-suite would
  // otherwise make these assertions order-dependent: exactly the cross-file shared-state class
  // CAT-154 exists to eliminate. The record is the invariant; the live var is not.
  const pinned = () => (process.env.CATALYST_HERMETIC_CLAUDE_CONFIG_DIR ?? "").split(":")[0];
  const live = () => (process.env.CLAUDE_CONFIG_DIR ?? "").split(":")[0];
  const realClaudeDir = resolve(homedir(), ".claude");

  test("preload pinned CLAUDE_CONFIG_DIR under the hermetic dir, never the real ~/.claude", () => {
    expect(process.env.CATALYST_HERMETIC_CLAUDE_CONFIG_DIR).toBeDefined();
    const p = resolve(pinned());
    expect(p).not.toBe(realClaudeDir);
    expect(p.startsWith(realClaudeDir + sep)).toBe(false);
    expect(p.startsWith(resolve(process.env.CATALYST_HERMETIC_DIR))).toBe(true);
  });

  test("the pinned path is guaranteed-absent (like the Layer-2 pin)", () => {
    expect(existsSync(pinned())).toBe(false);
  });

  // This one reads the LIVE var on purpose: the property under test is that claudeConfigDir()
  // honors whatever CLAUDE_CONFIG_DIR currently says, so both sides must come from the same
  // source to stay self-consistent under a sibling's temporary override.
  test("claudeConfigDir() resolves to the live pin, not the real tree", () => {
    expect(resolve(claudeConfigDir())).toBe(resolve(live()));
  });

  test("the preload's live pin and its record agree at rest", () => {
    expect(resolve(live())).toBe(resolve(pinned()));
  });
});
