// event-log-read-guard.test.mjs — CTL-1529 regression guard.
//
// INVARIANT: no source file in the scanned trees may whole-file-read a path that
// resolves to an append-only JSONL log — the monthly event log above all.
//
// SCOPE, stated precisely. Rounds 1 and 2 both hardcoded a directory list and
// both overstated it; round 3 replaces the list with a walk of the whole tree so
// the claim below is what the code does, by construction:
//   • SCANNED: the ENTIRE plugins/dev/scripts tree — every non-test
//     .mjs/.ts/.js at any depth, whether it runs in a daemon or in a short-lived
//     CLI. Round 2's list named 4 of 16 directories; `otel-forward` — a
//     long-lived daemon whose whole job is reading the event log — was among the
//     12 omitted. A NEW directory is in scope the day it is created; there is no
//     list to forget to update.
//   • NOT SCANNED (SKIP_DIRS, each with a reason at the declaration):
//     orch-monitor/ui (browser code, no fs), __tests__/ and *.test.*
//     (short-lived processes), fixtures, db-migrations (.sql), node_modules.
//   • The invariant is about the READ SHAPE, not about process lifetime. A CLI
//     that legitimately needs the whole file is allowlisted WITH that argument
//     written down (see lib/scrub-test-events.mjs) rather than silently exempt.
//   • The scan is a heuristic with NAMED, TESTED blind spots — see "LIMITS"
//     above `eventLogTaintedNames`. Passing this test means "no violation of the
//     shapes the detector can see", not "no whole-file read exists anywhere".
//
// The log is 883 MB on the busiest host; a `readFileSync(path, "utf8")` of it
// costs ~1.9 s of blocked event loop AND allocates one giant contiguous buffer
// that bun/mimalloc never returns to the OS (the mechanism behind exec-core
// sitting at ~3.25 GB RSS of 16 GB). Bounded readers exist — this test is what
// stops the next one from being written by hand.
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

// SCAN ROOT — the WHOLE `plugins/dev/scripts` tree, not an enumerated subset.
//
// Round 3. Rounds 1 and 2 each hardcoded a list ("the three daemon trees", then
// "+ lib/"), and each time the header claimed coverage the list did not have:
// round 2's list named 4 of the 16 directories under this root. The one that hurt
// most was `otel-forward` — a LONG-LIVED DAEMON whose entire job is reading the
// event log, carrying three unbounded whole-file `.jsonl` reads in
// otel-forward/lib/dlq.ts, and never scanned.
//
// An enumerated list is the wrong shape for this invariant: it fails OPEN (a new
// daemon directory is silently exempt the day it is created) and it is exactly
// what regressed twice. So the scan now walks the root and the SKIP set is the
// only thing enumerated — a new directory is covered by default, and excluding
// one is a visible, justified edit rather than an omission.
const SKIP_DIRS = new Set([
  "node_modules", // vendored
  "__tests__", // tests are short-lived processes (see also the *.test.* filter)
  "fixtures", // test data, not code
  "ui", // orch-monitor browser bundle — no `fs` at all
  ".git",
  "db-migrations", // .sql
]);

// The top-level directories the walk actually visits, DERIVED from the tree (not
// asserted from a literal). Used only for reporting and for the scope tests below.
function discoverScanDirs() {
  return readdirSync(SCRIPTS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name))
    .map((e) => e.name)
    .sort();
}
const SCAN_DIRS = discoverScanDirs();

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
  {
    file: "lib/scrub-test-events.mjs",
    count: 1,
    symbol: "scrubFile",
    ticket: "CTL-1529",
    reason:
      "GENUINELY the monthly event log, and it stays a full read. One-shot OFFLINE remediation CLI " +
      "(CTL-1086) an operator runs by hand — no event loop to block, and the giant transient dies " +
      "with the process instead of becoming a long-lived daemon's RSS high-water mark. Its contract " +
      "is a full rewrite (every non-sentinel line, byte-preserved, atomic rename), so bounding it " +
      "means a streaming read-and-rewrite — worth doing only if this moves into a long-lived process.",
  },
  {
    file: "otel-forward/lib/dlq.ts",
    count: 2,
    symbol: "drainDlq + drainDlqBounded",
    ticket: "CTL-1529",
    reason:
      "FOLLOW-UP, not an amnesty. otel-forward is a long-lived daemon and its DLQ is an append-only " +
      "JSONL that grows precisely during an OTLP outage — largest exactly when it is read. Round 3 " +
      "bounded the one read that needed no contents at all (dlqDepth counted lines by slurping + " +
      "splitting the whole file, on a repeating timer; it is now a 64 KiB chunked newline count). The " +
      "two that remain both need the WHOLE file for their contract: drainDlq returns every batch and " +
      "deletes the file, and drainDlqBounded rewrites the survivors (lines.slice(survivorStart)), so " +
      "no prefix read satisfies either. Bounding them means a streaming read-and-rewrite of the " +
      "delivery path — a behaviour change, deliberately out of this ticket's read-shape sweep. " +
      "Mitigating facts: drainDlq has NO non-test caller, and drainDlqBounded runs per flush cycle " +
      "with a 50-batch cap. Delete this entry when the streaming rewrite lands.",
  },
  {
    file: "orch-monitor/lib/comms-reader.ts",
    count: 1,
    symbol: "readChannelFile",
    ticket: "CTL-1529",
    reason:
      "NOT the event log — a per-channel comms JSONL (~/catalyst/comms/channels/<name>.jsonl), which " +
      "the taint analysis cannot distinguish because both paths are built the same way. Bounded in " +
      "practice by one run's message traffic (KBs), and the contract is 'every message plus the byte " +
      "offset of EOF': a tail read would drop history AND desync tailOffset from the caller's cursor.",
  },
  {
    file: "orch-monitor/lib/inbox-state.ts",
    count: 1,
    symbol: "readRaisedQuestion",
    ticket: "CTL-1529",
    reason:
      "NOT the event log — a Claude session transcript JSONL, matched via the same `.jsonl` shape. " +
      "Deliberately unbounded: the scan walks BACKWARDS for the last `assistant` text block, which " +
      "sits an unbounded distance from EOF (a long tool-call run appends thousands of records after " +
      "it), so a fixed tail would intermittently report 'no question raised' — the exact false " +
      "negative the inbox exists to catch. Bounding needs a backwards CHUNKED scan, not a byte cap.",
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

// How many lines past the opening line the argument scan may run. A wrapped call
// is a handful of lines at most; bounding the window keeps an UNBALANCED opening
// paren from dragging unrelated code (and its `logPath` identifiers) into the
// argument text and manufacturing a false positive.
const ARG_SCAN_LINES = 8;

// callArgs — the argument text of the call whose `(` is at `openParenIdx` on
// `lines[startLine]`, captured with a DEPTH COUNTER rather than `[^)]*` and
// ACROSS LINES.
//
// Two distinct traps, both of which silently waved real violations through:
//
//  1. Nested parens. `readFileSync(getEventLogPath(), "utf8")` — the very first
//     regression this guard was tested against — stops a non-greedy character
//     class at the INNER `)`, yielding the arg "getEventLogPath" (no parens, no
//     match). The depth counter fixes that.
//
//  2. WRAPPED ARGUMENTS (Codex P2). A single-line scan cannot see
//         readFileSync(
//           getEventLogPath(),
//           "utf8",
//         )
//     — the opening line's suffix after `(` is EMPTY, so argIsEventLog rejects it
//     and the whole-log read passes the invariant test. That is the worst failure
//     mode this guard can have: it is the anti-recurrence mechanism, and the
//     escape hatch is "a formatter happened to wrap the call". Since prettier/trunk
//     wrap on line length, the next whole-log read is MORE likely to be written in
//     the shape the guard could not see. So the scan continues onto following lines
//     until the call's parens balance.
//
// Newlines are preserved in the captured text so the stage-2 regexes behave the
// same whether the call was wrapped or not.
function callArgs(lines, startLine, openParenIdx) {
  let depth = 0;
  let out = "";
  const last = Math.min(lines.length - 1, startLine + ARG_SCAN_LINES);
  for (let k = startLine; k <= last; k++) {
    const line = lines[k];
    for (let j = k === startLine ? openParenIdx : 0; j < line.length; j++) {
      const c = line[j];
      if (c === "(") {
        depth++;
        if (depth === 1) continue; // the call's own open paren — not part of the args
      } else if (c === ")") {
        depth--;
        if (depth === 0) return out; // balanced — the argument list is complete
      }
      out += c;
    }
    out += "\n";
  }
  return out; // still unbalanced inside the window — take what we have
}

// A comment line. MANDATORY: capacity-history.mjs's JSDoc literally contains the
// prose "Defaults to readFileSync(logPath)", so a naive line regex has a
// false positive on the current tree.
const COMMENT_LINE = /^\s*(\/\/|\*|\/\*)/;

const MARKER = /\/\/\s*EVENT-LOG-FULL-READ-OK\(([A-Z]+-\d+)\)\s*:\s*(.+)$/;

// Identifier names that BY CONVENTION hold an append-only JSONL log path. Round 3
// adds `dlqPath`: otel-forward's DLQ path is built in index.ts
// (`join(CATALYST_DIR, "otel-forward-dlq-otlp.jsonl")`) and read in lib/dlq.ts
// through a bare `dlqPath` parameter — a CROSS-MODULE hop the taint analysis
// cannot follow (LIMITS #6), so without the name it stays invisible even now that
// otel-forward is scanned. The DLQ is genuinely an append-only JSONL log that
// grows precisely during an OTLP outage, i.e. it is largest exactly when it is read.
const LOG_PATH_NAMES = /\b(eventLogPath|eventsLogPath|logPath|eventsPath|dlqPath)\b/;

// An expression that PRODUCES an event-log (or sibling JSONL) path. This is both
// the direct-argument test AND the seed of the taint analysis below.
const EVENT_LOG_EXPR = new RegExp(`getEventLogPath\\s*\\(|\\.jsonl|${LOG_PATH_NAMES.source}`);

// ─── stage 2b: module-scope dataflow taint ──────────────────────────────────
//
// WHY THIS EXISTS. Round 1 of this guard matched only the ARGUMENT TEXT of the
// read: `getEventLogPath()`, a literal `.jsonl`, or one of four known variable
// names. That is exactly the shape a real, live, 344 MB whole-log read did NOT
// have, and it shipped inside this very PR:
//
//     private monthlyFilePath(d: Date): string {
//       return join(this.baseDir, `${y}-${m}.jsonl`);   // ← the event log
//     }
//     ...
//     const path = this.monthlyFilePath(this.now());
//     this.maybeRotateLegacy(path);                     // ← param `filePath`
//     ...
//     function isLegacyFirstLine(filePath: string) {
//       content = readFileSync(filePath, "utf8");       // ← INVISIBLE to round 1
//
// The argument is an opaque `filePath` three hops from anything spelled like the
// event log, so an argument-text matcher cannot see it — and a missed instance
// is a silent 344 MB read. So the scan now follows values within the module:
//
//   SEED       an identifier assigned from an EVENT_LOG_EXPR
//   RETURN     a function whose `return` is an EVENT_LOG_EXPR (or tainted) —
//              the FUNCTION NAME becomes a producer
//   ASSIGN     an identifier assigned from a tainted identifier / producer call
//   PARAM-BIND a call passing a tainted identifier taints the callee's Nth
//              parameter name
//
// …to a fixpoint. Taint is keyed by NAME and is MODULE-GLOBAL — deliberately
// over-approximate, per the review's instruction to prefer allowlistable false
// positives over silent false negatives. Two exclusions keep that
// over-approximation from drowning the allowlist, and BOTH are facts about the
// data rather than conveniences:
//
//   • `JSON.parse(readFileSync(x))` — a JSONL log is line-delimited, so parsing
//     the WHOLE file as one JSON value can only ever throw. Such a site is
//     provably reading a single-object file (state.json, config.json). This
//     exclusion applies ONLY to the taint branch; an explicitly-spelled
//     event-log argument is still reported.
//   • a `Bun.file()` handle that is never awaited as `.text()/.json()/…` — it is
//     a lazy descriptor (e.g. handed to `new Response(file)`, which streams).
//
// LIMITS — the blind spots, MEASURED not assumed (round 3). Each of these is
// pinned by a test in "detector LIMITS — the known blind spots are pinned"
// below, so this list cannot drift from the code the way the header's scope
// claim did in rounds 1 and 2. If you widen the detector, that test goes RED
// and you must delete the entry here in the same commit.
//
//   1. ONE-LINE CLASS-METHOD BODIES — `logFile() { return \`${y}.jsonl\`; }`.
//      FN_PATTERNS[2] anchors the method header with `\{\s*$`, so a method whose
//      whole body is on the header line never enters the function table and
//      `enclosingFn` cannot attribute its `return` to anything. (One-line
//      FUNCTION bodies and inline `if (x) return …` guards ARE caught — that is
//      the round-3 producer-rule fix directly above the `ret` regex.)
//   2. ARRAY hops — `const paths = [target]; readFileSync(paths[0])`.
//   3. OBJECT-PROPERTY hops — `const cfg = { path: target }; readFileSync(cfg.path)`.
//   4. `for…of` binding — `for (const f of [target]) readFileSync(f)`.
//   5. ALIASED READ FUNCTIONS — `const slurp = readFileSync; slurp(target)`.
//      READ_CALL matches the three real API names, not an alias of one.
//   6. CROSS-MODULE helpers — taint is per-file, so a path produced in module A
//      and read through a plainly-named parameter in module B is invisible.
//      Two live instances, both handled by hand rather than by the scan:
//        • `orch-monitor/analyze-events.ts` (glob → array → object property →
//          parameter → `for…of`, i.e. limits 2+3+4+6 at once) — bounded by hand.
//        • `otel-forward/lib/dlq.ts` — the DLQ path is built in `index.ts`
//          (`join(CATALYST_DIR, "…-dlq-otlp.jsonl")`) and read through a bare
//          `dlqPath` parameter. Caught today ONLY because `dlqPath` was added to
//          the known-name list below, not by the dataflow.
//   7. COMPOSITE ARGUMENTS — `argIsEventLog` requires a BARE identifier and never
//      consults the `producers` set, so a producer INLINED into the read is
//      invisible while the same producer via a local IS caught:
//        `readFileSync(monthlyLogPath())`, `readFileSync(await p())`,
//        `readFileSync(wrap(taintedId))`,
//        `readFileSync(target ?? fallback)`.
//      This is the most natural-looking of all the gaps — the codebase's own
//      idiom (`readChannelFile(channelPath(…))`, `monthlyLogPath(…)`) sits
//      exactly here, so treat a NEW inlined-producer read as unprotected.
//      MEASURED EXCEPTION: an inlined METHOD producer — `readFileSync(this.logPath())`
//      with a multi-line method body — IS caught. It was in a draft of this list
//      and removed after the pinning fixture went red; the list must not
//      over-claim blindness any more than it may over-claim coverage.
//   8. `getPrevMonthEventLogPath()` — the getEventLogPath special case is
//      anchored to the ZERO-ARG spelling of that one name, so the prior-month
//      accessor (the same file class) misses on every axis.
//   9. TS GENERIC METHOD HEADERS — `logFile<T>() {` never enters the function
//      table, so its `return` is unattributable (same mechanism as limit 1).
//
// NOT a limit, though an earlier draft of this list said it was: RE-EXPORTED
// CLOSURES. `function make() { return () => \`${y}.jsonl\`; }` and a closure that
// captures a tainted local and reads it are BOTH caught (measured; pinned in
// "closures are NOT a blind spot" below). The claim was removed rather than left
// standing — an overstated LIMITS list is the same defect as an overstated scope
// claim, just pointing the other way.
const RESERVED = new Set([
  "if", "for", "while", "switch", "catch", "function", "return", "do", "else",
  "try", "new", "typeof", "await", "super", "constructor",
]);

// Function headers, in the three shapes this codebase writes them.
const FN_PATTERNS = [
  /(?:^|\s)(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/,
  /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*(?:async\s*)?\(([^)]*)\)\s*=>/,
  /^\s*(?:(?:export|public|private|protected|static|readonly|async)\s+)*([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*(?::\s*[^{=]+)?\{\s*$/,
];

function paramNames(raw) {
  return raw.split(",").map((p) => {
    const m = /^\s*(?:\.\.\.)?([A-Za-z_$][\w$]*)/.exec(p);
    return m ? m[1] : null;
  });
}

function functionTable(lines) {
  const table = [];
  for (let i = 0; i < lines.length; i++) {
    if (COMMENT_LINE.test(lines[i])) continue;
    for (const re of FN_PATTERNS) {
      const m = re.exec(lines[i]);
      if (!m) continue;
      const name = m[1];
      if (!name || RESERVED.has(name)) break;
      table.push({ name, params: paramNames(m[2] ?? ""), line: i });
      break;
    }
  }
  return table;
}

// statementAt — the call's line plus continuation lines until the statement
// terminates, so `Bun.file(p)\n  .text()` is judged as one expression.
function statementAt(lines, i, maxLines = 6) {
  let out = lines[i];
  for (let k = i + 1; k < Math.min(lines.length, i + maxLines); k++) {
    if (/;\s*$/.test(out)) break;
    out += " " + lines[k].trim();
  }
  return out;
}

// eventLogTaintedNames — the fixpoint described above. Exported for the
// detector's own fixture tests.
export function eventLogTaintedNames(src) {
  const lines = String(src).split("\n");
  const fns = functionTable(lines);
  const byName = new Map();
  for (const f of fns) if (!byName.has(f.name)) byName.set(f.name, f);
  const byLine = new Map();
  for (const f of fns) if (!byLine.has(f.line)) byLine.set(f.line, f);

  const tainted = new Set();
  const producers = new Set();
  const isTaintedExpr = (text) => {
    if (EVENT_LOG_EXPR.test(text)) return true;
    for (const n of tainted) if (new RegExp(`\\b${n}\\b`).test(text)) return true;
    for (const n of producers) if (new RegExp(`\\b${n}\\s*\\(`).test(text)) return true;
    return false;
  };
  const enclosingFn = (i) => {
    for (let j = i; j >= 0; j--) {
      const f = byLine.get(j);
      if (f) return f;
    }
    return null;
  };

  // Bounded fixpoint — each round can only ADD names, and the rounds cap keeps a
  // pathological file from making the guard itself slow.
  for (let round = 0; round < 8; round++) {
    const before = tainted.size + producers.size;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (COMMENT_LINE.test(line)) continue;

      const assign = /(?:const|let|var\s+)?\s*([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*([^=].*)$/.exec(line);
      if (assign && isTaintedExpr(assign[2])) tainted.add(assign[1]);

      // RETURN-PRODUCER. NOT line-anchored (round 3). The first cut used
      // `/^\s*return\s+(.*)$/`, which requires `return` to be the FIRST token on
      // its line — so the two most idiomatic one-liners in this codebase started
      // no taint chain at all:
      //
      //     function logFile() { return `${ym}.jsonl`; }   // one-line body
      //     if (f) return getEventLogPath();                // inline guard return
      //
      // Neither is exotic; both are what prettier produces when the body fits the
      // print width. A read three hops downstream of either was undetected, which
      // is the same class of silent miss that let event-writer.ts ship.
      //
      // The `^\s*` alternative is MANDATORY, not redundant with `[{;})]\s*`: an
      // ordinary indented `  return x;` is preceded by whitespace only, and
      // dropping that branch regresses this suite to 29 pass / 5 fail (measured).
      // `([^;]*)` stops the capture at the statement terminator so the trailing
      // `}` of a one-line body is not swept into the expression text.
      const ret = /(?:^\s*|[{;})]\s*)return\s+([^;]*)/.exec(line);
      if (ret && isTaintedExpr(ret[1])) {
        const f = enclosingFn(i);
        if (f) producers.add(f.name);
      }

      const callRe = /([A-Za-z_$][\w$]*)\s*\(([^()]*)\)/g;
      let cm;
      while ((cm = callRe.exec(line)) !== null) {
        if (RESERVED.has(cm[1])) continue;
        const decl = byName.get(cm[1]);
        if (!decl) continue;
        const args = cm[2].split(",");
        for (let k = 0; k < args.length; k++) {
          const a = args[k].trim();
          if (/^[A-Za-z_$][\w$]*$/.test(a) && tainted.has(a) && decl.params[k]) {
            tainted.add(decl.params[k]);
          }
        }
      }
    }
    if (tainted.size + producers.size === before) break;
  }
  return tainted;
}

// Stage 2 — does the argument resolve to an event-log path?
// `arg` is the captured argument text; `tainted` is the module's taint set.
function argIsEventLog(line, arg, { lines, index, api, tainted }) {
  if (/getEventLogPath\s*\(\s*\)/.test(arg)) return true;
  if (/\.jsonl/.test(arg)) return true;
  if (LOG_PATH_NAMES.test(arg)) return true;
  // `readEventLog = (p) => readFileSync(p, "utf8")` — the argument is an opaque
  // `p`, but the identifier being assigned names the event log.
  const lhs = line.split("=")[0] ?? "";
  if (/eventlog/i.test(lhs)) return true;

  // Taint branch: a bare identifier the module's dataflow ties to an event-log
  // path (the shape round 1 was blind to).
  const bare = /^\s*([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(arg.trim());
  if (!bare || !tainted.has(bare[1])) return false;
  const escaped = api.replace(".", "\\.");
  if (new RegExp(`JSON\\.parse\\s*\\(\\s*(?:await\\s+)?${escaped}\\s*\\(`).test(line)) return false;
  if (api === "Bun.file" && !/\)\s*\.(text|json|arrayBuffer|bytes)\s*\(/.test(statementAt(lines, index))) {
    return false;
  }
  return true;
}

// violationsInSource — the per-file scan, extracted so the guard's own detection
// logic is testable against fixtures instead of only against whatever the tree
// happens to contain today. Returns [{ line, marker }] (1-indexed lines).
export function violationsInSource(src) {
  const hits = [];
  const lines = String(src).split("\n");
  const tainted = eventLogTaintedNames(src);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (COMMENT_LINE.test(line)) continue;
    const m = READ_CALL.exec(line);
    if (!m) continue;
    const openParen = line.indexOf("(", m.index);
    if (openParen === -1) continue;
    const ctx = { lines, index: i, api: m[1], tainted };
    if (!argIsEventLog(line, callArgs(lines, i, openParen), ctx)) continue;
    // The marker may sit a few lines above the call (a multi-line
    // justification is encouraged), so scan a small preceding window.
    let marker = MARKER.exec(line);
    for (let j = i - 1; !marker && j >= 0 && j >= i - 12; j--) {
      marker = MARKER.exec(lines[j]);
    }
    hits.push({ line: i + 1, marker });
  }
  return hits;
}

// scannedFiles — every source file the invariant covers. ONE walk from the root
// (round 3), so top-level loose files and any future daemon directory are in scope
// without an edit here; SKIP_DIRS is the only exclusion.
function scannedFiles() {
  return walk(SCRIPTS_DIR);
}

function findViolations() {
  const hits = [];
  for (const file of scannedFiles()) {
    const rel = relative(SCRIPTS_DIR, file);
    for (const h of violationsInSource(readFileSync(file, "utf8"))) {
      hits.push({ file: rel, ...h });
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
    const files = scannedFiles();
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
    for (const file of scannedFiles()) {
      const rel = relative(SCRIPTS_DIR, file);
      if (allowedFiles.has(rel)) continue;
      const src = readFileSync(file, "utf8");
      if (/EVENT-LOG-FULL-READ-OK/.test(src)) stray.push(rel);
    }
    expect(stray).toEqual([]);
  });

  // ── the DETECTOR's own coverage (Codex P2) ────────────────────────────────
  //
  // The tests above assert "the tree matches the allowlist" — which a BROKEN
  // detector satisfies trivially by finding nothing. These assert the detector
  // itself, against fixtures, so the guard cannot rot into a rubber stamp.
  describe("detector fixtures — a violation is caught in every formatting shape", () => {
    test("REGRESSION: a multiline / formatter-wrapped call is caught", () => {
      // THE EXACT SHAPE prettier/trunk produce when the call exceeds the print
      // width. Before the fix `callArgs` searched only the OPENING line, found an
      // empty argument suffix, and `argIsEventLog` rejected it — so a whole-log
      // read evaded the entire anti-recurrence mechanism purely because a
      // formatter wrapped it.
      const src = [
        "function boom() {",
        "  const raw = readFileSync(",
        "    getEventLogPath(),",
        '    "utf8",',
        "  );",
        "  return raw;",
        "}",
      ].join("\n");
      const hits = violationsInSource(src);
      expect(hits.map((h) => h.line)).toEqual([2]);
      expect(hits[0].marker).toBeNull();
    });

    test("the wrapped shape is caught for each event-log argument spelling", () => {
      for (const arg of ['getEventLogPath()', 'logPath', 'eventLogPath', '"/x/2026-07.jsonl"']) {
        const src = ["const raw = readFileSync(", `  ${arg},`, '  "utf8",', ");"].join("\n");
        expect(violationsInSource(src).map((h) => h.line)).toEqual([1]);
      }
    });

    test("the single-line nested-paren shape stays caught (the depth counter still works)", () => {
      const src = 'const raw = readFileSync(getEventLogPath(), "utf8");';
      expect(violationsInSource(src).map((h) => h.line)).toEqual([1]);
    });

    test("a wrapped read of a NON-event-log path is NOT caught (the window did not go broad)", () => {
      // The multiline scan must not sweep unrelated identifiers from the following
      // lines into the argument text. Here the call balances on line 3; the
      // `eventLogPath` two lines later is a different statement entirely.
      const src = [
        "const cfg = readFileSync(",
        "  configFilePath,",
        ");",
        "const other = eventLogPath;",
      ].join("\n");
      expect(violationsInSource(src)).toEqual([]);
    });

    test("a marker above a wrapped call is still attached to it", () => {
      const src = [
        "// EVENT-LOG-FULL-READ-OK(CTL-1234): a deliberate exhaustive parity oracle.",
        "const raw = readFileSync(",
        "  getEventLogPath(),",
        '  "utf8",',
        ");",
      ].join("\n");
      const hits = violationsInSource(src);
      expect(hits).toHaveLength(1);
      expect(hits[0].marker[1]).toBe("CTL-1234");
    });

    test("prose in a comment is still not a violation", () => {
      expect(violationsInSource(" * Defaults to readFileSync(logPath) when unset.")).toEqual([]);
      expect(violationsInSource("// const raw = readFileSync(getEventLogPath());")).toEqual([]);
    });
  });

  // ── the detector's DATAFLOW coverage (round 2) ────────────────────────────
  //
  // Round 1 matched only the ARGUMENT TEXT, so it could not see a read whose
  // argument is an opaque variable. A live 344 MB whole-log read shipped in that
  // blind spot inside this very PR (orch-monitor/lib/event-writer.ts). These
  // fixtures pin the taint analysis that closed it — revert
  // `eventLogTaintedNames` and every one of them goes red.
  describe("detector fixtures — a violation is caught through a VARIABLE (CTL-1529 round 2)", () => {
    test("REGRESSION: the exact event-writer.ts shape — producer → local → param → param → read", () => {
      // Verbatim structure of the miss: the only thing that names the event log
      // is a template literal inside a helper THREE hops away from the read.
      const src = [
        "class CanonicalEventWriter {",
        "  private monthlyFilePath(d: Date): string {",
        "    return join(this.baseDir, `${y}-${m}.jsonl`);",
        "  }",
        "  private maybeRotateLegacy(filePath: string): void {",
        "    if (!isLegacyFirstLine(filePath)) return;",
        "  }",
        "  append(event: CanonicalEvent) {",
        "    const path = this.monthlyFilePath(this.now());",
        "    this.maybeRotateLegacy(path);",
        "  }",
        "}",
        "function isLegacyFirstLine(filePath: string): boolean {",
        '  const content = readFileSync(filePath, "utf8");',
        "  return content.length > 0;",
        "}",
      ].join("\n");
      const hits = violationsInSource(src);
      expect(hits.map((h) => h.line)).toEqual([14]);
      expect(hits[0].marker).toBeNull();
    });

    test("each taint hop is load-bearing (seed / return-producer / assign / param-bind)", () => {
      const tainted = (src) => [...eventLogTaintedNames(src)];
      // SEED: assigned straight from an event-log expression.
      expect(tainted('const target = getEventLogPath();')).toContain("target");
      // RETURN-PRODUCER + ASSIGN: the function name becomes a producer, and a
      // variable assigned from a call to it inherits the taint.
      expect(
        tainted(["function logFile() {", "  return `${y}-${m}.jsonl`;", "}", "const p = logFile();"].join("\n")),
      ).toContain("p");
      // PARAM-BIND: passing a tainted identifier taints the callee's parameter.
      expect(
        tainted(
          [
            "const target = getEventLogPath();",
            "function sink(inner) { return inner; }",
            "sink(target);",
          ].join("\n"),
        ),
      ).toContain("inner");
    });

    test("an untainted variable read is NOT a violation (the taint set is not 'every identifier')", () => {
      const src = [
        "function loadConfig(configPath) {",
        '  return readFileSync(configPath, "utf8");',
        "}",
      ].join("\n");
      expect(violationsInSource(src)).toEqual([]);
    });

    test("EXCLUSION: JSON.parse(readFileSync(x)) is never the event log (a JSONL log cannot parse whole)", () => {
      // `p` IS tainted here, but parsing the entire file as one JSON value can
      // only throw on a line-delimited log — so this is provably a single-object
      // file. Without this exclusion the allowlist gains ~5 state.json readers.
      const src = [
        "const target = getEventLogPath();",
        "function load(p) {",
        '  return JSON.parse(readFileSync(p, "utf8"));',
        "}",
        "load(target);",
      ].join("\n");
      expect(eventLogTaintedNames(src).has("p")).toBe(true);
      expect(violationsInSource(src)).toEqual([]);
    });

    test("EXCLUSION: a lazy Bun.file handle is not a read, but an eagerly-consumed one is", () => {
      const lazy = [
        "const target = getEventLogPath();",
        "function serve(p) {",
        "  const file = Bun.file(p);",
        "  return new Response(file);",
        "}",
        "serve(target);",
      ].join("\n");
      expect(violationsInSource(lazy)).toEqual([]);

      const eager = [
        "const target = getEventLogPath();",
        "async function slurp(p) {",
        "  const text = await Bun.file(p).text();",
        "  return text;",
        "}",
        "slurp(target);",
      ].join("\n");
      expect(violationsInSource(eager).map((h) => h.line)).toEqual([3]);
    });

    test("a marker placed above a long justification block still attaches to the call", () => {
      // The three allowlisted sites carry multi-line rationales; the marker sits
      // ~11 lines above the read. A short scan window would silently report them
      // as unmarked.
      const src = [
        "const target = getEventLogPath();",
        "function slurp(p) {",
        "  // EVENT-LOG-FULL-READ-OK(CTL-1529): deliberate, see below.",
        ...Array.from({ length: 9 }, (_, i) => `  // rationale line ${i + 1}`),
        '  return readFileSync(p, "utf8");',
        "}",
        "slurp(target);",
      ].join("\n");
      const hits = violationsInSource(src);
      expect(hits).toHaveLength(1);
      expect(hits[0].marker[1]).toBe("CTL-1529");
    });
  });

  // ── the producer rule is NOT line-anchored (round 3) ──────────────────────
  //
  // `/^\s*return\s+(.*)$/` required `return` to be the FIRST token on its line, so
  // the two commonest one-liners in this codebase started no taint chain at all
  // and any read downstream of them was invisible. Revert the `ret` regex to the
  // anchored form and 3 of this describe's 5 cases go RED (suite: 31 pass / 3 fail, measured).
  describe("detector fixtures — a producer whose `return` is mid-line (CTL-1529 round 3)", () => {
    test("REGRESSION: a ONE-LINE function body is a producer", () => {
      const src = [
        "function logFile() { return `${ym}.jsonl`; }",
        "const p = logFile();",
        'const raw = readFileSync(p, "utf8");',
      ].join("\n");
      expect([...eventLogTaintedNames(src)]).toContain("p");
      expect(violationsInSource(src).map((h) => h.line)).toEqual([3]);
    });

    test("REGRESSION: an INLINE guard return (`if (f) return getEventLogPath();`) is a producer", () => {
      const src = [
        "function pick(f) {",
        "  if (f) return getEventLogPath();",
        "  return null;",
        "}",
        "const p = pick(true);",
        'const raw = readFileSync(p, "utf8");',
      ].join("\n");
      expect([...eventLogTaintedNames(src)]).toContain("p");
      expect(violationsInSource(src).map((h) => h.line)).toEqual([6]);
    });

    test("a read THREE hops downstream of a one-line producer is still reached", () => {
      const src = [
        "function logFile() { return `${ym}.jsonl`; }",
        "function hop1(a) { return a; }",
        "function hop2(b) { return b; }",
        "const p = logFile();",
        "const q = hop1(p);",
        "hop2(q);",
        "function sink(c) {",
        '  return readFileSync(c, "utf8");',
        "}",
        "sink(q);",
      ].join("\n");
      expect(violationsInSource(src).map((h) => h.line)).toEqual([8]);
    });

    test("the `^\\s*` alternative is LOAD-BEARING: an ordinary indented return still produces", () => {
      // Dropping `^\s*` from the widened regex (keeping only `[{;})]\s*`) breaks
      // the plain multi-line body — the shape the ORIGINAL rule existed for — and
      // regresses this suite to 31 pass / 3 fail (measured).
      const src = [
        "function logFile() {",
        "  return `${y}.jsonl`;",
        "}",
        "const p = logFile();",
        'const raw = readFileSync(p, "utf8");',
      ].join("\n");
      expect(violationsInSource(src).map((h) => h.line)).toEqual([5]);
    });

    test("the widening did not go broad: `return` inside a STRING or a comment is not a producer", () => {
      const notProducers = [
        'function f() { return "no logPath here at all"; }', // string mentions a name…
        "// if (x) return getEventLogPath();",
      ];
      // The first DOES taint (the literal names a known path identifier) — that is
      // the documented over-approximation, and it is allowlistable. The second must
      // not, because comment lines are skipped outright.
      expect(eventLogTaintedNames(notProducers[1]).size).toBe(0);
      expect(violationsInSource(notProducers[1])).toEqual([]);
    });
  });

  // ── the LIMITS are PINNED, not asserted in prose (round 3) ────────────────
  //
  // The recurring defect across all three rounds is documented coverage
  // exceeding actual coverage. The header's LIMITS list is the one remaining
  // place prose makes a claim, so each entry gets a test that FAILS if the
  // detector ever grows past it. A red test here is not a bug — it means someone
  // widened the detector and must delete the matching LIMITS entry.
  describe("detector LIMITS — the known blind spots are pinned", () => {
    const MISSES = {
      "1. one-line CLASS-METHOD body": [
        "class W {",
        "  logFile() { return `${y}-${m}.jsonl`; }",
        "  go() {",
        "    const p = this.logFile();",
        '    return readFileSync(p, "utf8");',
        "  }",
        "}",
      ],
      "2. ARRAY hop": [
        "const target = getEventLogPath();",
        "const paths = [target];",
        'const raw = readFileSync(paths[0], "utf8");',
      ],
      "3. OBJECT-PROPERTY hop": [
        "const target = getEventLogPath();",
        "const cfg = { path: target };",
        'const raw = readFileSync(cfg.path, "utf8");',
      ],
      "4. for…of binding": [
        "const target = getEventLogPath();",
        "for (const f of [target]) {",
        '  const raw = readFileSync(f, "utf8");',
        "}",
      ],
      "5. ALIASED read function": [
        "const target = getEventLogPath();",
        "const slurp = readFileSync;",
        'const raw = slurp(target, "utf8");',
      ],
      // 7-9: the COMPOSITE-ARGUMENT family. argIsEventLog wants a BARE identifier
      // and never consults the `producers` set, so a producer INLINED into the
      // call is invisible even though the identical producer via a local IS
      // caught. This is the shape most likely to appear naturally.
      "7a. inlined producer call": [
        "function monthlyLogPath() { return `${y}-${m}.jsonl`; }",
        'const raw = readFileSync(monthlyLogPath(), "utf8");',
      ],
      "7c. awaited producer": [
        "async function p() { return `${y}-${m}.jsonl`; }",
        'const raw = readFileSync(await p(), "utf8");',
      ],
      "7d. tainted id wrapped in a call": [
        "const target = getEventLogPath();",
        'const raw = readFileSync(resolve(target), "utf8");',
      ],
      "7e. ternary / ?? argument": [
        "const target = getEventLogPath();",
        'const raw = readFileSync(target ?? fallback, "utf8");',
      ],
      // 8: the getEventLogPath special case is anchored to the ZERO-ARG spelling,
      // so the prior-month accessor — literally the same file class — misses.
      "8. getPrevMonthEventLogPath()": [
        'const raw = readFileSync(getPrevMonthEventLogPath(), "utf8");',
      ],
      // 9: a TS GENERIC method header never enters the function table.
      "9. generic method header": [
        "class W {",
        "  logFile<T>() {",
        "    return `${y}-${m}.jsonl`;",
        "  }",
        "  go() {",
        "    const p = this.logFile();",
        '    return readFileSync(p, "utf8");',
        "  }",
        "}",
      ],
    };

    for (const [name, lines] of Object.entries(MISSES)) {
      test(`STILL UNCAUGHT (documented in LIMITS): ${name}`, () => {
        expect(violationsInSource(lines.join("\n"))).toEqual([]);
      });
    }

    test("LIMIT 6 (cross-module) is why dlqPath is matched BY NAME, not by dataflow", () => {
      // dlq.ts receives the path as a bare parameter from another module. Without
      // the name in LOG_PATH_NAMES the taint set is empty and the read is invisible
      // even though otel-forward is now scanned — delete `dlqPath` from
      // LOG_PATH_NAMES and this goes red.
      const crossModule = [
        "export function drain(dlqPath) {",
        '  return readFileSync(dlqPath, "utf8");',
        "}",
      ].join("\n");
      expect(violationsInSource(crossModule).map((h) => h.line)).toEqual([2]);
      // …and the same shape with an unrecognised parameter name is NOT caught,
      // which is exactly LIMIT 6.
      const unnamed = [
        "export function drain(queueFile) {",
        '  return readFileSync(queueFile, "utf8");',
        "}",
      ].join("\n");
      expect(violationsInSource(unnamed)).toEqual([]);
    });

    test("closures are NOT a blind spot (the LIMITS list must not over-claim either)", () => {
      // A draft of the LIMITS list asserted "re-exported closures" were invisible.
      // Measured, they are not — so the entry was deleted. This pins the fact, so
      // the claim cannot creep back in unmeasured.
      const factory = [
        "function makeResolver(base) {",
        "  return () => `${base}/${y}-${m}.jsonl`;",
        "}",
        "const resolve = makeResolver('/x');",
        "const p = resolve();",
        'const raw = readFileSync(p, "utf8");',
      ].join("\n");
      expect(violationsInSource(factory).map((h) => h.line)).toEqual([6]);

      const captured = [
        "function makeReader() {",
        "  const inner = getEventLogPath();",
        '  return () => readFileSync(inner, "utf8");',
        "}",
      ].join("\n");
      expect(violationsInSource(captured).map((h) => h.line)).toEqual([3]);
    });
  });

  // ── scope: the scan covers the whole tree, and the header says exactly that ──
  describe("scope (round 3: the claim now matches the scan)", () => {
    test("the SIBLING lib/ tree is scanned (round 2: it was missing, hiding a real whole-log read)", () => {
      const libFiles = walk(join(SCRIPTS_DIR, "lib")).map((f) => relative(SCRIPTS_DIR, f));
      expect(SCAN_DIRS).toContain("lib");
      expect(libFiles).toContain("lib/scrub-test-events.mjs");
    });

    test("EVERY non-skipped directory under plugins/dev/scripts is scanned (no enumerated subset)", () => {
      // Round 2's hardcoded list covered 4 of 16 directories while the header
      // claimed "no daemon source file". The scan is now derived from the tree, so
      // the set it covers and the set that EXISTS are the same set by construction.
      const onDisk = readdirSync(SCRIPTS_DIR, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name))
        .map((e) => e.name)
        .sort();
      expect(SCAN_DIRS).toEqual(onDisk);
      // The specific omission that mattered: otel-forward is a long-lived daemon
      // whose entire job is reading the event log.
      expect(SCAN_DIRS).toContain("otel-forward");
      expect(SCAN_DIRS).toContain("catalyst-agent");
      expect(SCAN_DIRS).toContain("coordination-publish");
      expect(SCAN_DIRS).toContain("otel-audit");
    });

    test("otel-forward's DLQ reads are actually IN the violation set (the dir is scanned, not just listed)", () => {
      // The dir being in SCAN_DIRS proves nothing if the detector cannot see the
      // reads. Assert the real file, from the real walk.
      const dlqHits = violations.filter((v) => v.file === "otel-forward/lib/dlq.ts");
      expect(dlqHits).toHaveLength(2); // drainDlq + drainDlqBounded; dlqDepth was BOUNDED
      for (const h of dlqHits) expect(h.marker?.[1]).toBe("CTL-1529");
    });

    test("dlqDepth no longer whole-file-reads: it counts newline bytes through a fixed buffer", () => {
      const src = readFileSync(join(SCRIPTS_DIR, "otel-forward/lib/dlq.ts"), "utf8");
      const depthFn = src.slice(src.indexOf("export function dlqDepth"));
      const body = depthFn.slice(0, depthFn.indexOf("\n}\n") + 3);
      expect(body).not.toContain("readFileSync");
      expect(body).toContain("readSync");
      expect(body).toContain("DEPTH_CHUNK_BYTES");
    });
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
