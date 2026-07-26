// event-log-read-guard.test.mjs — CTL-1529 regression guard.
//
// INVARIANT: no daemon source file may read the monthly event log with a
// whole-file API. The log is 883 MB on the busiest host; a `readFileSync(path,
// "utf8")` of it costs ~1.9 s of blocked event loop AND allocates one giant
// contiguous buffer that bun/mimalloc never returns to the OS (the mechanism
// behind exec-core sitting at ~3.25 GB RSS of 16 GB). Bounded readers exist —
// this test is what stops the next one from being written by hand.
//
// SHAPE: a source scan modeled on broker/namespace-parity.test.mjs, using
// SNAPSHOT-SET EQUALITY rather than a "no new violations" check. Set equality
// fails in BOTH directions: a new whole-file read fails (the point), and a FIXED
// site also fails until its stale allowlist entry is deleted — which is what keeps
// the allowlist from rotting into a permanent amnesty list.
//
// Every exemption must carry BOTH an allowlist entry with a real `reason` AND an
// in-source `// EVENT-LOG-FULL-READ-OK(<TICKET>): <why>` marker, so the exemption
// is visible at the code and no one can self-exempt by sprinkling the marker.
//
// Approved bounded readers to migrate toward:
//   execution-core/event-tail.mjs   scanEventsSince   (time-covering tail + coverage verdict)
//                                   scanEventsChunked (forward fold, bounded memory)
//                                   tailParsedEvents  (last-N events)
//   orch-monitor/lib/event-log-reader.ts  scanFileLines (forward, bounded memory)
//
// Run: cd plugins/dev/scripts/execution-core && bun test event-log-read-guard.test.mjs

import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const EC_DIR = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = join(EC_DIR, "..");

// The three daemon trees. orch-monitor/ui is browser code with no fs at all.
const SCAN_DIRS = ["execution-core", "broker", "orch-monitor"];
const SKIP_DIRS = new Set(["node_modules", "__tests__", "fixtures", "ui", ".git", "db-migrations"]);

// ─── the allowlist ──────────────────────────────────────────────────────────
//
// Every entry needs `ticket` + a `reason` that states the TRADEOFF, not just
// "it's fine". Deleting a site from the tree without deleting its entry FAILS.
// Keyed on FILE + COUNT, deliberately not on line number: a line-keyed snapshot
// churns on every unrelated edit above the site and trains people to bump it
// without reading it. file×count still fails closed — a NEW read in an already-
// allowlisted file changes the count, and a read in any other file is a new key.
const ALLOWLIST = [
  {
    file: "orch-monitor/lib/substep-reader.ts",
    count: 1,
    symbol: "readSubStepEventsFromFile",
    ticket: "CTL-1529",
    reason:
      "DEAD in production — the /api/ticket-substeps route uses the ring path with no file fallback, " +
      "and the only non-test reference is __tests__/ticket-substeps-ring.test.ts. It is retained " +
      "deliberately as the parity ORACLE that test asserts the ring against; bounding it would weaken " +
      "the oracle (an oracle should be the dumb exhaustive implementation). Delete it and the parity " +
      "test together, or not at all.",
  },
];

// ─── the scanner ────────────────────────────────────────────────────────────

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(join(dir, e.name), out);
      continue;
    }
    if (!/\.(mjs|ts|js)$/.test(e.name)) continue;
    if (/\.(test|spec)\.[cm]?[jt]s$/.test(e.name)) continue; // tests are short-lived processes
    if (/\.d\.m?ts$/.test(e.name)) continue;
    out.push(join(dir, e.name));
  }
  return out;
}

// Stage 1 — unbounded whole-file read APIs.
const READ_CALL = /\b(readFileSync|readFile|Bun\.file)\s*\(/;

// callArgs — the argument text of the call starting at `openParenIdx`, captured
// with a DEPTH COUNTER rather than `[^)]*`. This matters: the very first
// regression this guard was tested against —
// `readFileSync(getEventLogPath(), "utf8")` — has a nested `)`, and a
// non-greedy character class stops at it, yielding the arg "getEventLogPath"
// (no parens, no match) and silently waving the violation through.
function callArgs(line, openParenIdx) {
  let depth = 0;
  for (let i = openParenIdx; i < line.length; i++) {
    const c = line[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return line.slice(openParenIdx + 1, i);
    }
  }
  return line.slice(openParenIdx + 1); // unterminated on this line — take the rest
}

// A comment line. MANDATORY: capacity-history.mjs's JSDoc literally contains the
// prose "Defaults to readFileSync(logPath)", so a naive line regex has a
// false positive on the current tree.
const COMMENT_LINE = /^\s*(\/\/|\*|\/\*)/;

const MARKER = /\/\/\s*EVENT-LOG-FULL-READ-OK\(([A-Z]+-\d+)\)\s*:\s*(.+)$/;

// Stage 2 — does the argument resolve to an event-log path?
function argIsEventLog(line, arg) {
  if (/getEventLogPath\s*\(\s*\)/.test(arg)) return true;
  if (/\.jsonl/.test(arg)) return true;
  if (/\b(eventLogPath|eventsLogPath|logPath|eventsPath)\b/.test(arg)) return true;
  // `readEventLog = (p) => readFileSync(p, "utf8")` — the argument is an opaque
  // `p`, but the identifier being assigned names the event log.
  const lhs = line.split("=")[0] ?? "";
  if (/eventlog/i.test(lhs)) return true;
  return false;
}

function findViolations() {
  const hits = [];
  for (const d of SCAN_DIRS) {
    for (const file of walk(join(SCRIPTS_DIR, d))) {
      const src = readFileSync(file, "utf8");
      const lines = src.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (COMMENT_LINE.test(line)) continue;
        const m = READ_CALL.exec(line);
        if (!m) continue;
        const openParen = line.indexOf("(", m.index);
        if (openParen === -1) continue;
        if (!argIsEventLog(line, callArgs(line, openParen))) continue;
        // The marker may sit a few lines above the call (a multi-line
        // justification is encouraged), so scan a small preceding window.
        let marker = MARKER.exec(line);
        for (let j = i - 1; !marker && j >= 0 && j >= i - 8; j--) {
          marker = MARKER.exec(lines[j]);
        }
        hits.push({ file: relative(SCRIPTS_DIR, file), line: i + 1, marker });
      }
    }
  }
  return hits;
}

const violations = findViolations();
const keyOf = (v) => `${v.file}:${v.line}`;

describe("event-log whole-file read guard (CTL-1529)", () => {
  test("the scanner is wired up (it finds SOME reads, i.e. it did not silently match nothing)", () => {
    // A scanner that walks the wrong directory happily reports zero violations
    // forever. Assert it actually visited real source.
    const files = SCAN_DIRS.flatMap((d) => walk(join(SCRIPTS_DIR, d)));
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((f) => f.endsWith("recovery.mjs"))).toBe(true);
    expect(files.some((f) => f.endsWith("tailer.mjs"))).toBe(true);
    expect(files.some((f) => f.endsWith("board-data.mjs"))).toBe(true);
  });

  test("every allowlist entry carries a ticket and a substantive reason", () => {
    for (const e of ALLOWLIST) {
      expect(e.ticket).toMatch(/^[A-Z]+-\d+$/);
      expect(typeof e.reason).toBe("string");
      expect(e.reason.trim().length).toBeGreaterThan(40);
      expect(typeof e.file).toBe("string");
      expect(Number.isInteger(e.count) && e.count > 0).toBe(true);
    }
  });

  test("the set of whole-file event-log reads EQUALS the allowlist (no additions, no stale entries)", () => {
    const counts = new Map();
    for (const v of violations) counts.set(v.file, (counts.get(v.file) ?? 0) + 1);
    const found = [...counts.entries()].map(([f, n]) => `${f} x${n}`).sort();
    const allowed = ALLOWLIST.map((e) => `${e.file} x${e.count}`).sort();
    // WHEN THIS FAILS:
    //   • an entry appears in `found` but not `allowed` → you added a whole-file
    //     read of the event log. Use a bounded reader (see the header) or, if the
    //     read is genuinely unavoidable, add an allowlist entry AND the in-source
    //     EVENT-LOG-FULL-READ-OK marker stating the tradeoff.
    //   • an entry appears in `allowed` but not `found` → you FIXED a site (thank
    //     you). Delete its allowlist entry so the allowlist keeps shrinking.
    expect(found).toEqual(allowed);
  });

  test("each allowlisted site carries an in-source EVENT-LOG-FULL-READ-OK marker", () => {
    for (const v of violations) {
      expect({ site: keyOf(v), hasMarker: Boolean(v.marker) }).toEqual({
        site: keyOf(v),
        hasMarker: true,
      });
      expect(v.marker[1]).toMatch(/^[A-Z]+-\d+$/);
      expect(v.marker[2].trim().length).toBeGreaterThan(10);
    }
  });

  test("the marker cannot be used to self-exempt: it only appears on allowlisted sites", () => {
    const allowedFiles = new Set(ALLOWLIST.map((e) => e.file));
    const stray = [];
    for (const d of SCAN_DIRS) {
      for (const file of walk(join(SCRIPTS_DIR, d))) {
        const rel = relative(SCRIPTS_DIR, file);
        if (allowedFiles.has(rel)) continue;
        const src = readFileSync(file, "utf8");
        if (/EVENT-LOG-FULL-READ-OK/.test(src)) stray.push(rel);
      }
    }
    expect(stray).toEqual([]);
  });

  test("the ticket's own target (readClusterHeartbeats) is bounded", () => {
    const src = readFileSync(join(EC_DIR, "recovery.mjs"), "utf8");
    // The bounded primitive is wired in…
    expect(src).toContain("scanEventsSince");
    // …and the local heartbeat scan reports a coverage verdict rather than
    // silently truncating.
    expect(src).toContain("HeartbeatWindowError");
  });
});
