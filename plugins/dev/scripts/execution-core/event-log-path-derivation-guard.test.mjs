// event-log-path-derivation-guard.test.mjs — CTL-1216 Phase 2.
//
// THE GUARD THAT STOPS THE 33rd SITE.
//
// Before CTL-1216 the event-log rotation scheme was re-derived at 32 production
// sites, including FOUR byte-identical getEventLogPath() copies. Nothing failed
// when a 33rd was added, because "writer and readers agree" was a property that
// held only by every site independently computing the same string.
//
// Modelled on execution-core/event-name-read-guard.test.mjs's snapshot-equality
// posture, and deliberately inheriting its most important property: it FAILS IN
// BOTH DIRECTIONS. A newly-added self-derivation turns CI red, and a site that
// gets fixed must DELETE its allowlist entry or CI goes red the other way. An
// allowlist that only ever grows is a scoreboard, not a guard.
//
// ── WHY THERE IS A POSITIVE CONTROL ─────────────────────────────────────────
// A scanner whose regex silently stops matching returns an empty set, and an
// empty set compared against an empty allowlist PASSES. `[].every(p)` is `true`
// and this repo has shipped that false-clean before (AGENTS.md, "Reporting a
// negative"). So the scanner is run against a fixture that is KNOWN to contain a
// derivation, and must find exactly it. A check that cannot fail is not evidence.
//
// ── WHY /usr/bin/grep IS NOT USED ───────────────────────────────────────────
// This scanner reads the files itself with node:fs. The agent shell's `grep` is
// a `ugrep --ignore-files` wrapper that honours .gitignore, which is the exact
// mechanism that has produced false "not configured anywhere" answers here.
// Reading the bytes directly sidesteps the question entirely.

import { test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, relative, basename } from "node:path";
import { tmpdir } from "node:os";

const SCRIPTS_ROOT = join(import.meta.dir, "..");

// Directories that are not ours to police.
const SKIP_DIRS = new Set(["node_modules", "ui", "vendor", ".git", "dist", "build", "orch-monitor-ui"]);

// The scanned extensions, plus the extensionless CLIs this repo ships.
const SCAN_EXTS = [".mjs", ".ts", ".js", ".sh", ".mts", ".cts"];
const SCAN_BARE = new Set(["catalyst-events", "catalyst-stack", "catalyst-comms", "catalyst-hud"]);

// The three shapes a self-derived event-log filename takes in this tree.
//   JS/TS:  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2,"0")}`
//   JS/TS:  d.toISOString().slice(0, 7)
//   bash:   $(date -u +%Y-%m)
const DERIVATION_PATTERNS = [
  /getUTCMonth\(\)\s*\+\s*1/,
  /toISOString\(\)\.slice\(0,\s*7\)/,
  /date\s+-u\s+\+%Y-%m\)/,
  /date\s+-u\s+\+%G-W%V\)/,
];

// Files that OWN the derivation — the leaf, its bash mirror, and their tests.
// These are the one place the scheme is allowed to be computed.
const OWNERS = new Set([
  "lib/event-log-paths.mjs",
  "lib/catalyst-event-log-paths.sh",
]);

function isScannable(name) {
  if (SCAN_BARE.has(name)) return true;
  if (name.includes(".test.")) return false; // tests may construct paths freely
  return SCAN_EXTS.some((e) => name.endsWith(e));
}

export function scanForSelfDerivedEventLogNames(root) {
  const found = new Set();
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (entry === "__tests__") continue; // tests may construct paths freely
        walk(full);
        continue;
      }
      if (!isScannable(basename(full))) continue;
      const rel = relative(root, full);
      if (OWNERS.has(rel)) continue;
      let text;
      try {
        text = readFileSync(full, "utf8");
      } catch {
        continue;
      }
      for (const line of text.split("\n")) {
        // A comment is prose, not a derivation. Strip the obvious comment
        // forms before matching so documenting the old shape in a header
        // cannot turn CI red.
        const code = line.replace(/^\s*(\/\/|#|\*)\s?.*$/, "");
        if (!code) continue;
        if (DERIVATION_PATTERNS.some((p) => p.test(code))) {
          found.add(rel);
          break;
        }
      }
    }
  };
  walk(root);
  return found;
}

// ── the snapshot ────────────────────────────────────────────────────────────
// Every entry here is a site that still derives the filename itself. Fixing one
// means DELETING its line — the equality below fails in both directions, so a
// fixed site that stays listed is just as red as a new site that is not.
const ALLOWED_REMAINING = [
  // ── still to fold, Phase 2 (readers) ──────────────────────────────────────
  "catalyst-events",
  "channel-watcher/channel-watcher.mjs",
  "coordination-publish/index.ts",
  "event-mirror/index.ts",
  "execution-core/doctor.mjs",
  "execution-core/recovery-pass-context.mjs",
  "orch-monitor/lib/activity-briefing.ts",
  "orch-monitor/lib/event-log-reader.ts",
  "orch-monitor/lib/event-ring.ts",
  "orch-monitor/lib/journey.mjs",
  "orch-monitor/lib/service-health-monitor.ts",
  "orch-monitor/lib/substep-reader.ts",
  "orch-monitor/server.ts",
  "otel-forward/lib/tail.ts",

  // ── still to fold, Phase 4 (writers) ──────────────────────────────────────
  "lib/canonical-event.sh",
  "catalyst-state.sh",
  "emit-worker-status-change.sh",
  "lib/emit-reap-intent.sh",
  "catalyst-stack",
  "orch-monitor/lib/event-writer.ts",
  "otel-forward/index.ts",

  // ── standalone helper scripts, outside the ticket's declared blast radius ─
  "test-catalyst-session.sh",
  "orchestrate-replay-phase-events.sh",
  "catalyst-hud-classic.sh",
];

test("no un-migrated event-log filename derivations remain outside the leaf", () => {
  const found = scanForSelfDerivedEventLogNames(SCRIPTS_ROOT);
  expect([...found].sort()).toEqual([...ALLOWED_REMAINING].sort());
});

test("the scanner actually detects one (positive control)", () => {
  // Guard against a scanner that returns [] because its regex is wrong: a check
  // that cannot fail is not evidence, and [].every(p) is true.
  const dir = mkdtempSync(join(tmpdir(), "ctl1216-guard-"));
  try {
    writeFileSync(
      join(dir, "fake-site.mjs"),
      'const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;\n',
    );
    writeFileSync(join(dir, "innocent.mjs"), "export const x = 1;\n");
    const found = scanForSelfDerivedEventLogNames(dir);
    expect([...found]).toEqual(["fake-site.mjs"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the scanner detects each derivation shape, not just the first (positive control)", () => {
  const shapes = {
    "a.mjs": 'const ym = `${y}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;\n',
    "b.ts": 'const ym = d.toISOString().slice(0, 7);\n',
    "c.sh": 'f="$dir/$(date -u +%Y-%m).jsonl"\n',
    "d.sh": 'f="$dir/$(date -u +%G-W%V).jsonl"\n',
  };
  for (const [name, body] of Object.entries(shapes)) {
    const dir = mkdtempSync(join(tmpdir(), "ctl1216-shape-"));
    try {
      writeFileSync(join(dir, name), body);
      expect([...scanForSelfDerivedEventLogNames(dir)]).toEqual([name]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("a derivation mentioned in a COMMENT is prose, not a site", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctl1216-comment-"));
  try {
    writeFileSync(
      join(dir, "documented.mjs"),
      "// Historically this computed getUTCMonth() + 1 inline; it now delegates.\n" +
        "# was: $(date -u +%Y-%m)\n" +
        "export const x = 1;\n",
    );
    expect([...scanForSelfDerivedEventLogNames(dir)]).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the scan actually reached the real tree (positive control on the walk)", () => {
  // A walk that silently returned nothing would make the snapshot assertion
  // above vacuous in the direction that matters. Assert the allowlist is
  // non-empty AND that at least one known-present file was visited.
  expect(ALLOWED_REMAINING.length).toBeGreaterThan(0);
  const found = scanForSelfDerivedEventLogNames(SCRIPTS_ROOT);
  expect(found.has("lib/canonical-event.sh")).toBe(true);
});
