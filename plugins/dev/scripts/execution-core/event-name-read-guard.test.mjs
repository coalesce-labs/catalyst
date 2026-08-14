// event-name-read-guard.test.mjs — CTL-1834 regression guard.
//
// INVARIANT: no source file in the scanned tree may spell its OWN multi-key
// event-name ladder. The name of an event on ~/catalyst/events/YYYY-MM.jsonl is
// resolved in exactly one place — `lib/event-name.mjs` `getEventName` — so a new
// envelope shape is a one-line change there instead of a hunt through the tree.
//
// WHY THIS SHAPE OF GUARD, MEASURED. Three envelope shapes coexist on the log:
// v1 `event`, v2 `attributes["event.name"]`, v3 `name`. Before this ticket five
// files hand-rolled a ladder, in THREE MUTUALLY INCOMPATIBLE ORDERS, each with a
// different blind spot (2026-08 census, 2,577,330 lines):
//     event ?? attributes            blind to    1,006 lines
//     attributes ?? name             blind to  160,789 lines
//     attributes only                blind to  161,795 lines
// The last is the nastiest: it is not a visible zero but a BIASED SLICE — an
// attributes-only reader sees 1.56% of `orphans.reap-requested`, which looks like
// data. Three separate v3 producers were each found and fixed REACTIVELY, one at a
// time, after their events were already lost, and CTL-1817's own in-tree comment
// undercounted the v3 population it had just measured by 1.9x (531 claimed vs
// 1,006 actual across 44 names). This file is what makes the fourth drift fail at
// CI instead of on the log.
//
// SCOPE, stated precisely — this is a HEURISTIC with NAMED, TESTED blind spots.
//   • SCANNED: the ENTIRE plugins/dev/scripts tree, every non-test .mjs/.ts/.js/
//     .tsx at any depth (SKIP_DIRS below is the only exclusion), so a new daemon
//     directory is in scope the day it is created. Modeled on
//     event-log-read-guard.test.mjs, whose enumerated-directory-list predecessor
//     failed OPEN twice.
//   • DETECTED: a single statement that reads the v2 key literal AND at least one
//     of the v1/v3 keys, joined by `??` / `||` / a ternary. That is a ladder, and a
//     ladder is by definition a re-implementation of the boundary.
//   • NOT DETECTED (blind spots, each with a fixture test below so the limit is
//     asserted rather than claimed):
//       (a) a ladder spread across SEPARATE STATEMENTS (`const v2 = ...; if (v2)
//           return v2; if (typeof o.event === "string") ...`). That was
//           otel-forward's describeUnknownShape, folded by hand in this ticket.
//       (b) a SINGLE-KEY read (`attributes["event.name"]` alone, `.event` alone).
//           ~35 such sites remain and are DELIBERATELY out of CTL-1834's scope —
//           see "DEFERRED, NOT FORGOTTEN" below. Detecting a bare `.event` /
//           `.name` would also be uselessly noisy: every `foo.name` in the tree.
//       (c) bash/jq consumers. `catalyst-events --filter` pushes the read onto 97
//           caller sites and its own --help teaches two contradictory conventions.
//     Passing this test means "no ladder of the shape the detector can see", never
//     "every consumer calls getEventName".
//
// DEFERRED, NOT FORGOTTEN — the honest scope statement for CTL-1834. After this
// ticket the tree still contains ~35 single-key `attributes`-only readers (the
// larger blind spot by volume), execution-core/reaper.mjs's v1-only family, and
// the bash consumers above. reaper.mjs in particular must NOT be folded on the
// name alone: its payload reads (`event.bg_job_id`, `event.ticket`,
// `event.worktree_path`) are v1-flat too, so a name-only fold would make it
// RECOGNIZE a v2 line, consume its dedupe slot, then silently drop it — strictly
// worse than uniformly ignoring it. Each of those is its own ticket.
//
// SHAPE: snapshot-SET equality, not a "no new violations" check. Set equality
// fails in BOTH directions — a new ladder fails (the point), and a FIXED site also
// fails until its stale allowlist entry is deleted, which is what keeps the
// allowlist from rotting into a permanent amnesty list. Every exemption needs BOTH
// an allowlist entry with a real reason AND an in-source
// `// EVENT-NAME-LADDER-OK(<TICKET>): <why>` marker, so no one can self-exempt by
// sprinkling the marker and no one can exempt silently from this file.
//
// Run: cd plugins/dev/scripts/execution-core && bun test event-name-read-guard.test.mjs

import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const EC_DIR = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = join(EC_DIR, "..");

const SKIP_DIRS = new Set([
  "node_modules", // vendored
  "__tests__", // test-only code
  "fixtures", // test data
  ".git",
  "db-migrations", // .sql
]);

// ─── the allowlist ──────────────────────────────────────────────────────────
//
// Keyed on FILE + COUNT, deliberately not on line number: a line-keyed snapshot
// churns on every unrelated edit above the site and trains people to bump it
// without reading it. file x count still fails closed — a NEW ladder in an
// already-allowlisted file changes the count.
//
// EMPTY IS THE INTENDED STEADY STATE. CTL-1834 folded all five pre-existing
// ladders, so nothing is exempt today. An empty expected set is exactly the
// `[].every(p) === true` shape this repo has shipped before, which is why the
// detector is separately proven live three ways below: fixture tests of
// `laddersInSource`, an assertion that the walk visits real files, and a
// REAL-FILE positive control that writes a ladder into the scanned tree and
// re-runs the whole scan.
const ALLOWLIST = [];

// ─── the detector ───────────────────────────────────────────────────────────

const COMMENT_LINE = /^\s*(\/\/|\*|\/\*)/;
const V2_KEY = /\[\s*"event\.name"\s*\]/;
const V1_KEY = /\.event\b(?!\.)/;
const V3_KEY = /\.name\b/;
const JOINER = /\?\?|\|\||\?/;
const MARKER = /EVENT-NAME-LADDER-OK\(([A-Z]+-\d+)\):\s*(.+)$/;

// maskStrings — blank every string literal EXCEPT the "event.name" key itself.
//
// MANDATORY, not defensive. Without it `resource?.["service.name"] ?? "catalyst"`
// (otel-forward/lib/destinations/*.ts) matches V3_KEY on the `.name` inside the
// string "service.name", and three correct canonical-envelope readers are reported
// as ladders. Measured: 3 false positives before this masking, 0 after.
export function maskStrings(text) {
  return String(text).replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, (m) =>
    /^["'`]event\.name["'`]$/.test(m) ? '"event.name"' : '""',
  );
}

// statementAt — the whole statement containing line `i`, so a prettier-wrapped
// ternary is judged as one expression. Bounded in BOTH directions so a
// pathological file cannot make the guard slow.
//
// ⛔ IT MUST SCAN BACKWARD TOO (Codex P2 on #3356). The caller anchors on the line
// holding the v2 key, but prettier is free to put the OTHER arm first:
//
//     const name =
//       event.event ??                       // <- v1 arm, ABOVE the anchor
//       event.attributes?.["event.name"];    // <- anchor line
//
// A forward-only window starting at the anchor never sees `event.event`, so
// `laddersInSource` returned no hit and the empty allowlist stayed green for a
// hand-rolled ladder the guard claims to detect. The original positive-control
// fixture only exercised the opposite ordering, so it could not catch this — a
// guard that cannot see half its own target is the defect class this repo keeps
// paying for.
//
// The anchor stays "v2 key on THIS line", so a multi-line statement still reports
// exactly once (the dedup that collapsed 19 raw hits to 10 real sites is intact).
function statementAt(lines, i, maxLines = 4) {
  // Walk back ONLY across lines that clearly CONTINUE an expression — i.e. that end
  // in a joiner or assignment (`??`, `||`, `&&`, `=`, `(`). That is exactly the
  // shape prettier produces when it wraps a ladder:
  //
  //     const name =            <- ends `=`,  crossed
  //       event.event ??        <- ends `??`, crossed
  //       event.attributes?.["event.name"];
  //
  // A permissive "stop only at `;{}`" rule is WRONG and I measured it: it walked up
  // into an object-literal KEY line (`"event.name":` in
  // orch-monitor/ui/src/hooks/use-activity.ts), whose bare `name` plus the
  // following ternary's `?` satisfied the ladder pattern and reported a builder
  // that is not a ladder at all. Widening a detector until it invents hits is the
  // same failure as one that misses them — this bound keeps it honest in both
  // directions.
  let start = i;
  for (let k = i - 1; k >= 0 && k > i - maxLines; k--) {
    const prev = lines[k].trim();
    if (prev === "" || COMMENT_LINE.test(prev)) break;
    if (!/(\?\?|\|\||&&|=|\()\s*$/.test(prev)) break;
    start = k;
  }
  // Forward extent is measured from the ANCHOR, not from `start`. Widening it to
  // `start + maxLines*2` swallowed neighbouring object-literal properties and
  // produced a false positive on use-activity.ts (an `attributes: { "event.name":
  // … }` builder, which is not a ladder at all) — the backward walk had correctly
  // stopped at `attributes: {`. Extending the window backward must not also extend
  // it forward: a detector that starts inventing hits is no better than one that
  // misses them.
  let out = lines[start];
  for (let k = start + 1; k < Math.min(lines.length, i + maxLines); k++) {
    if (/;\s*$/.test(out)) break;
    out += " " + lines[k].trim();
  }
  return out;
}

// laddersInSource — the per-file scan, exported so the detector's own logic is
// testable against fixtures instead of only against whatever the tree happens to
// contain today. Returns [{ line, marker }] (1-indexed).
//
// A hit requires the v2 key ON THIS LINE (not merely somewhere in the
// continuation window). Without that anchor a multi-line statement reports once
// per line of the window — measured: 19 raw hits collapse to 10 real sites.
export function laddersInSource(src) {
  const hits = [];
  const lines = String(src).split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (COMMENT_LINE.test(lines[i])) continue;
    if (!V2_KEY.test(maskStrings(lines[i]))) continue;
    const stmt = maskStrings(statementAt(lines, i));
    // Remove the v2 key before probing for the OTHER keys, so `["event.name"]`
    // cannot satisfy V1_KEY/V3_KEY by itself.
    const rest = stmt.replace(new RegExp(V2_KEY.source, "g"), "«V2»");
    if (!JOINER.test(rest)) continue;
    if (!V1_KEY.test(rest) && !V3_KEY.test(rest)) continue;
    // The marker may sit a few lines above (a multi-line justification is
    // encouraged), so scan a small preceding window.
    let marker = MARKER.exec(lines[i]);
    for (let j = i - 1; !marker && j >= 0 && j >= i - 10; j--) marker = MARKER.exec(lines[j]);
    hits.push({ line: i + 1, marker });
  }
  return hits;
}

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
    if (!/\.(mjs|ts|js|tsx)$/.test(e.name)) continue;
    if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(e.name)) continue;
    if (/\.d\.m?ts$/.test(e.name)) continue;
    out.push(join(dir, e.name));
  }
  return out;
}

const scannedFiles = () => walk(SCRIPTS_DIR);

function findLadders() {
  const hits = [];
  for (const file of scannedFiles()) {
    const rel = relative(SCRIPTS_DIR, file);
    for (const h of laddersInSource(readFileSync(file, "utf8"))) hits.push({ file: rel, ...h });
  }
  return hits;
}

const ladders = findLadders();
const keyOf = (v) => `${v.file}:${v.line}`;

describe("event-name ladder guard (CTL-1834)", () => {
  test("the scanner is wired up — it visits real source, not an empty set", () => {
    // A scanner pointed at the wrong directory reports zero violations forever.
    const files = scannedFiles();
    expect(files.length).toBeGreaterThan(100);
    // Named anchors, one per stack, so a SKIP_DIRS edit that silently drops a
    // whole tree fails here.
    for (const anchor of [
      "broker/router.mjs",
      "execution-core/monitor.mjs",
      "lib/event-name.mjs",
      "orch-monitor/lib/event-analysis.ts",
      "otel-forward/index.ts",
    ]) {
      expect({ anchor, scanned: files.some((f) => f.endsWith(anchor)) }).toEqual({
        anchor,
        scanned: true,
      });
    }
  });

  test("REAL-FILE POSITIVE CONTROL — a ladder written into the scanned tree IS found", () => {
    // The mandated control, and the one that a fixture test CANNOT give: a fixture
    // test proves the REGEX matches a string, it does not prove the WALK reached
    // any file. An enumeration that goes empty makes every set-equality assertion
    // above pass vacuously, and that exact mechanism regressed twice in CTL-1529.
    //
    // So: write a real file containing a real ladder into the real scan root, run
    // the FULL findLadders() pipeline, and assert it is reported.
    const probe = join(SCRIPTS_DIR, "__ctl1834_ladder_probe.mjs");
    try {
      writeFileSync(
        probe,
        [
          "// generated by event-name-read-guard.test.mjs — deleted in the same test",
          "export function probe(event) {",
          '  return event.event ?? event.attributes?.["event.name"] ?? "";',
          "}",
          "",
        ].join("\n"),
      );
      const found = findLadders();
      const probeHits = found.filter((h) => h.file === "__ctl1834_ladder_probe.mjs");
      expect(probeHits).toHaveLength(1);
      expect(probeHits[0].line).toBe(3);
      expect(probeHits[0].marker).toBeNull();
      // And the whole-tree assertion below would have FAILED with it present —
      // i.e. the guard's verdict really is driven by the walk.
      expect(found.length).toBe(ladders.length + 1);
    } finally {
      rmSync(probe, { force: true });
    }
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

  test("the set of hand-rolled ladders EQUALS the allowlist (no additions, no stale entries)", () => {
    const counts = new Map();
    for (const v of ladders) counts.set(v.file, (counts.get(v.file) ?? 0) + 1);
    const found = [...counts.entries()].map(([f, n]) => `${f} x${n}`).sort();
    const allowed = ALLOWLIST.map((e) => `${e.file} x${e.count}`).sort();
    // WHEN THIS FAILS:
    //   • in `found`, not in `allowed` -> you hand-rolled an event-name ladder.
    //     Call `getEventName` from lib/event-name.mjs. If the site genuinely
    //     cannot (say the shape predicate in otel-forward/lib/tail.ts, which is a
    //     different question and would drop the pino stream), add an allowlist
    //     entry AND the in-source EVENT-NAME-LADDER-OK marker stating the tradeoff.
    //   • in `allowed`, not in `found` -> you FIXED a site. Delete its entry so the
    //     allowlist keeps shrinking.
    expect(found).toEqual(allowed);
  });

  test("each allowlisted site carries an in-source EVENT-NAME-LADDER-OK marker", () => {
    for (const v of ladders) {
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
      if (/EVENT-NAME-LADDER-OK/.test(readFileSync(file, "utf8"))) stray.push(rel);
    }
    expect(stray).toEqual([]);
  });

  test("the boundary itself is not a ladder the guard has to exempt", () => {
    // lib/event-name.mjs resolves each key in its OWN statement with an early
    // return, so it is not a single-statement ladder and needs no exemption. If
    // someone rewrites it as a one-line `??` chain this fails and they must
    // allowlist it — which is the right prompt, since a one-liner cannot express
    // the first-NON-EMPTY-string rule.
    const src = readFileSync(join(SCRIPTS_DIR, "lib", "event-name.mjs"), "utf8");
    expect(laddersInSource(src)).toEqual([]);
    // ...and it really does read all three keys (the guard must not pass because
    // the boundary went missing).
    expect(src).toContain("event.attributes?.[");
    expect(src).toContain("const v3 = event.name;");
  });
});

// ─── the DETECTOR's own coverage ────────────────────────────────────────────
//
// Everything above asserts "the tree matches the allowlist" — which a BROKEN
// detector satisfies trivially by finding nothing. These assert the detector.
describe("detector fixtures — ladders are caught, non-ladders are not", () => {
  const line = (src) => laddersInSource(src).map((h) => h.line);

  test("the shipped pre-CTL-1834 ladders, in all three orders", () => {
    expect(line('const n = event.event ?? event.attributes?.["event.name"] ?? "";')).toEqual([1]);
    expect(line('const n = event?.attributes?.["event.name"] ?? event?.event;')).toEqual([1]);
    expect(line('const n = attrs["event.name"] ?? o.name ?? "";')).toEqual([1]);
    expect(line('const n = isCanonical ? asString(attrs["event.name"]) : asString(obj.event);')).toEqual([1]);
    expect(line('const n = a["event.name"] || o.event;')).toEqual([1]);
  });

  test("a prettier-wrapped ladder is caught ONCE, at the v2 key's line", () => {
    const src = [
      "const rawEventName = isCanonical",
      '  ? asString(attrs["event.name"])',
      "  : asString(obj.event);",
    ].join("\n");
    expect(line(src)).toEqual([2]);
  });

  // Codex P2 on #3356. The fixture above only exercises v2-BEFORE-v1. Prettier is
  // equally free to emit the other order, and a forward-only statement window
  // starting at the v2 anchor never sees the v1 arm above it — so the guard
  // returned NO hit and the empty allowlist stayed green for a ladder it claims to
  // detect. Both orderings are now pinned; neither alone is sufficient evidence.
  test("a prettier-wrapped ladder with the v1 arm ABOVE the v2 key is caught too", () => {
    const src = [
      "const name =",
      "  event.event ??",
      '  event.attributes?.["event.name"];',
    ].join("\n");
    // Reported at the v2 key's line (3), same anchor convention as above.
    expect(line(src)).toEqual([3]);
  });

  test("the backward scan stops at a statement boundary (no false positive across statements)", () => {
    // A `;`-terminated line above must NOT be pulled into the window, or every
    // attributes-only read following an unrelated `event.event` line would be
    // reported — the guard would go from missing hits to inventing them.
    const src = [
      "const prev = obj.event;",
      'const only = attrs?.["event.name"];',
    ].join("\n");
    expect(line(src)).toEqual([]);
  });

  test("BLIND SPOT (a), asserted not claimed: a cross-statement ladder is NOT caught", () => {
    // otel-forward's describeUnknownShape had exactly this shape. It was folded by
    // hand in CTL-1834 and is pinned by otel-forward/event-name-fold.test.ts. If
    // this test ever starts failing, the detector got smarter — delete this test
    // and say so.
    const src = [
      'const v2 = attrs?.["event.name"];',
      "if (typeof v2 === 'string' && v2) return v2;",
      "if (typeof o.event === 'string' && o.event) return o.event;",
    ].join("\n");
    expect(line(src)).toEqual([]);
  });

  test("BLIND SPOT (b), asserted not claimed: a single-key read is NOT caught", () => {
    expect(line('const n = ev?.attributes?.["event.name"];')).toEqual([]);
    expect(line('const n = obj.event;')).toEqual([]);
    expect(line('attrs["event.name"] = name;')).toEqual([]);
  });

  test("a canonical-envelope read with an UNRELATED `.name` string is NOT caught", () => {
    // The measured false-positive class: three otel-forward destinations read
    // `resource?.["service.name"]` on the same line. Without maskStrings the
    // `.name` inside that STRING satisfies V3_KEY and all three are reported.
    const src = 'event.attributes?.["event.name"] ?? "unknown", event.resource?.["service.name"] ?? "catalyst",';
    expect(line(src)).toEqual([]);
  });

  test("maskStrings blanks every literal except the event.name key", () => {
    expect(maskStrings('a["service.name"] ?? "x.event"')).toBe('a[""] ?? ""');
    expect(maskStrings('a["event.name"]')).toBe('a["event.name"]');
  });

  test("prose in a comment is not a ladder", () => {
    expect(line('// getEventName = event.event ?? event.attributes["event.name"]')).toEqual([]);
    expect(line(' *   name = attributes["event.name"] ?? event ?? name')).toEqual([]);
  });

  test("a marker above a ladder is attached to it", () => {
    const src = [
      "// EVENT-NAME-LADDER-OK(CTL-9999): a deliberate divergence, explained at length.",
      'const n = e.event ?? e.attributes?.["event.name"] ?? "";',
    ].join("\n");
    const hits = laddersInSource(src);
    expect(hits).toHaveLength(1);
    expect(hits[0].marker[1]).toBe("CTL-9999");
    expect(hits[0].marker[2]).toContain("deliberate divergence");
  });

  test("a ladder with NO marker reports marker === null", () => {
    const hits = laddersInSource('const n = e.event ?? e.attributes?.["event.name"] ?? "";');
    expect(hits[0].marker).toBeNull();
  });
});
