// board-phase-drift.test.ts — CI drift guard locking the orch-monitor "board"
// phase-list copies to the single source of truth: the workflow descriptor
// (plugins/dev/scripts/lib/workflow.default.json, surfaced as PHASES /
// ANCILLARY_PHASES by lib/workflow-descriptor.mjs).
//
// WHY THIS GUARD EXISTS
// ─────────────────────
// The 9-phase pipeline order (triage → … → monitor-deploy) is defined ONCE in
// workflow.default.json. But the board renders that pipeline from several
// HARDCODED copies that were hand-written before the descriptor existed and are
// NOT auto-derived from it. If someone renames / reorders / adds / drops a phase
// in workflow.default.json, these copies silently go stale — the board keeps
// drawing the old columns and quietly mis-buckets tickets — with NO test failure.
// This file turns that silent drift into a hard CI failure (orch-monitor-quality
// workflow runs `bun test` on every PR touching orch-monitor/**).
//
// THE COPIES BEING GUARDED (and why each one exists)
// ──────────────────────────────────────────────────
//   DATA LAYER  — lib/board-data.mjs
//     • PHASE_ORDER     ordered 9-phase pipeline; the data layer's notion of
//                       phase progression. MUST equal descriptor PHASES exactly.
//     • PHASE_TO_LINEAR phase → human Linear-column label ("Research"/"Validate"
//                       /…). Its KEYS must cover every pipeline phase; its VALUE
//                       space defines which Linear columns the board can produce.
//
//   UI COLUMNS  — ui/src/board/Board.tsx
//     • PHASE_COLS      the visual board's phase columns (key + user-facing
//                       label). The .key order is the literal column order the
//                       user sees, so it MUST equal descriptor PHASES exactly.
//     • LINEAR_COLS     the visual board's Linear-lens columns. Must match the
//                       value-space the data layer (PHASE_TO_LINEAR) produces —
//                       every label the data layer emits needs a UI column, and
//                       no UI column may exist without a data-layer source.
//     • PHASE_C         phase → accent color. A SUPERSET of PHASES: it also
//                       carries ancillary `remediate` plus display aliases
//                       (merge/deploy/done), so it must at minimum cover every
//                       pipeline phase but may legitimately contain extras.
//
// NAMESPACE NOTE (intentional NON-assertion) — see requirement 8
// ─────────────────────────────────────────────────────────────
// We deliberately do NOT assert PHASE_TO_LINEAR === descriptor PHASE_LINEAR_KEY.
// They live in DIFFERENT namespaces: the board's PHASE_TO_LINEAR holds human
// column labels ("Research", "Validate"), while the descriptor's PHASE_LINEAR_KEY
// holds config stateMap keys ("research", "verifying"). Asserting equality would
// be WRONG. We only guard PHASE_TO_LINEAR's KEY coverage (vs PHASES) and its
// VALUE-space agreement with the UI's LINEAR_COLS.
//
// FIXING A FAILURE: the descriptor (workflow.default.json) is the source of
// truth. When it changes, update the copy named in the failing message to match —
// do not edit this test to make it pass.

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Source of truth: the workflow descriptor (derived from workflow.default.json).
import { PHASES, ANCILLARY_PHASES } from "../../lib/workflow-descriptor.mjs";
// Data-layer copies.
import { PHASE_ORDER, PHASE_TO_LINEAR } from "../lib/board-data.mjs";

const SOT = "workflow.default.json (via lib/workflow-descriptor.mjs PHASES)";

// ── Board.tsx text extraction ───────────────────────────────────────────────
// We read Board.tsx as TEXT (never import it) because it pulls in React + CSS +
// "@/…" path-aliased modules that don't resolve under `bun test`. This mirrors
// the column-widths.test.ts / event-row.test.tsx precedent of testing against a
// component's data, not the component itself. The PHASE_C / LINEAR_COLS /
// PHASE_COLS consts live at the top of the file in plain `const X = …;` form.
const HERE = dirname(fileURLToPath(import.meta.url));
const BOARD_TSX_PATH = join(HERE, "..", "ui", "src", "board", "Board.tsx");
const boardSrc = readFileSync(BOARD_TSX_PATH, "utf8");

/**
 * Slice out the literal initializer of a top-level `const <name> = …` from the
 * Board.tsx text. Returns the substring from the first non-space char after `=`
 * up to (and including) the terminating `;`. Brace/bracket-aware so nested `{…}`
 * / `[…]` (and `;` inside strings/objects) don't truncate early.
 */
function extractConstInitializer(src: string, name: string): string {
  // Match `const NAME` optionally followed by a TS type annotation, then `=`.
  // `name` is always a hardcoded literal at the call sites (PHASE_COLS /
  // LINEAR_COLS / PHASE_C), so this dynamic RegExp is not an injection vector.
  // eslint-disable-next-line security/detect-non-literal-regexp
  const re = new RegExp(`const\\s+${name}\\b[^=]*=`);
  const m = re.exec(src);
  if (!m) {
    throw new Error(
      `board-phase-drift: could not locate \`const ${name}\` in Board.tsx ` +
        `(${BOARD_TSX_PATH}). The board phase-list copies moved or were renamed; ` +
        `update this guard so it keeps tracking them against ${SOT}.`,
    );
  }
  let i = m.index + m[0].length;
  // Skip whitespace to the initializer's first real character.
  while (i < src.length && /\s/.test(src[i])) i++;
  const start = i;
  let depth = 0;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") depth--;
    else if (ch === ";" && depth === 0) {
      return src.slice(start, i + 1);
    }
  }
  throw new Error(
    `board-phase-drift: \`const ${name}\` initializer in Board.tsx was not ` +
      `terminated by ';' — the file shape changed; update this guard.`,
  );
}

/**
 * Pull the ordered list of `key:` string-literal values out of an object/array
 * literal initializer. Handles both bare-ident keys (`{ triage: "…" }`) and the
 * array-of-records form (`[{ key: "triage", … }]`). For the array-of-records
 * form we read the VALUE of each `key:` field; for the bare-object-map form we
 * read the property names themselves.
 *
 * `mode` picks which: "objectKeys" (PHASE_C / PHASE_TO_LINEAR-style maps) or
 * "recordKeyField" (PHASE_COLS / LINEAR_COLS array-of-records).
 */
function extractKeys(initializer: string, mode: "objectKeys" | "recordKeyField"): string[] {
  if (mode === "recordKeyField") {
    // Each record contributes one `key: "<value>"`. Order = source order.
    const out: string[] = [];
    const re = /\bkey\s*:\s*"([^"]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(initializer)) !== null) out.push(m[1]);
    return out;
  }
  // objectKeys: top-level property names of a `{ … }` map. Property keys are
  // either quoted ("monitor-merge":) or bare idents (triage:). We only want the
  // KEY tokens, i.e. an ident/quoted-string immediately followed by `:`, and not
  // a `key:` inside a nested record (board maps here are flat, so depth-1 only).
  const out: string[] = [];
  // Trim the outer braces so the matcher operates on the body.
  const body = initializer.replace(/^[\s\S]*?\{/, "").replace(/\}[\s;]*$/, "");
  // Match: optional quote, identifier/dashed-name, optional quote, then ':'.
  // Only count when at brace-depth 0 within the body (board color/label maps are
  // flat string→string maps, so every key is depth-0).
  let depth = 0;
  const re = /("([^"]+)"|([A-Za-z_][\w-]*))\s*:/g;
  // Walk char-by-char to track depth, re-checking matches only at depth 0.
  // Simpler + robust for these flat maps: scan tokens, tracking nesting.
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    if (ch === "{" || ch === "[" || ch === "(") {
      depth++;
      i++;
      continue;
    }
    if (ch === "}" || ch === "]" || ch === ")") {
      depth--;
      i++;
      continue;
    }
    if (depth === 0) {
      re.lastIndex = i;
      const m = re.exec(body);
      if (m && m.index === i) {
        out.push(m[2] ?? m[3]);
        i = re.lastIndex;
        continue;
      }
    }
    i++;
  }
  return out;
}

// Extract the three Board.tsx copies once.
const phaseColsKeys = extractKeys(extractConstInitializer(boardSrc, "PHASE_COLS"), "recordKeyField");
const linearColsKeys = extractKeys(extractConstInitializer(boardSrc, "LINEAR_COLS"), "recordKeyField");
const phaseCKeys = extractKeys(extractConstInitializer(boardSrc, "PHASE_C"), "objectKeys");

// ── Requirement 3: board-data PHASE_ORDER === descriptor PHASES (exact order) ─
test("board-data.mjs PHASE_ORDER equals descriptor PHASES exactly (order + elements)", () => {
  // Throw the actionable fix-message FIRST so it (not just bun's toEqual diff)
  // surfaces on drift; the trailing expect() registers the assertion when green.
  if (JSON.stringify(PHASE_ORDER) !== JSON.stringify([...PHASES])) {
    throw new Error(
      `DRIFT: lib/board-data.mjs PHASE_ORDER diverged from ${SOT}.\n` +
        `  descriptor PHASES: ${JSON.stringify([...PHASES])}\n` +
        `  board PHASE_ORDER: ${JSON.stringify(PHASE_ORDER)}\n` +
        `Fix board-data.mjs PHASE_ORDER to match workflow.default.json.`,
    );
  }
  expect(PHASE_ORDER).toEqual([...PHASES]);
});

// ── Requirement 4: PHASE_TO_LINEAR keys ⊇ PHASES (every phase is mapped) ──────
test("board-data.mjs PHASE_TO_LINEAR keys cover every descriptor PHASE (superset)", () => {
  const keys = new Set(Object.keys(PHASE_TO_LINEAR));
  const missing = [...PHASES].filter((p) => !keys.has(p));
  if (missing.length > 0) {
    throw new Error(
      `DRIFT: lib/board-data.mjs PHASE_TO_LINEAR is missing a Linear-column ` +
        `mapping for phase(s) ${JSON.stringify(missing)} present in ${SOT}. ` +
        `Add them to PHASE_TO_LINEAR. (Extra keys like "done" are allowed.)`,
    );
  }
  expect(missing).toEqual([]);
});

// ── Requirement 5a: Board.tsx PHASE_COLS .key order === PHASES (exact) ────────
test("Board.tsx PHASE_COLS keys equal descriptor PHASES exactly (visual column order)", () => {
  if (JSON.stringify(phaseColsKeys) !== JSON.stringify([...PHASES])) {
    throw new Error(
      `DRIFT: ui/src/board/Board.tsx PHASE_COLS (the visual board columns) ` +
        `diverged from ${SOT}.\n` +
        `  descriptor PHASES:    ${JSON.stringify([...PHASES])}\n` +
        `  Board.tsx PHASE_COLS: ${JSON.stringify(phaseColsKeys)}\n` +
        `Fix PHASE_COLS .key order/membership to match workflow.default.json.`,
    );
  }
  expect(phaseColsKeys).toEqual([...PHASES]);
});

// ── Requirement 5b: Board.tsx PHASE_C keys ⊇ PHASES (colors; extras allowed) ──
test("Board.tsx PHASE_C keys cover every descriptor PHASE (color map is a superset)", () => {
  const keys = new Set(phaseCKeys);
  const missing = [...PHASES].filter((p) => !keys.has(p));
  if (missing.length > 0) {
    throw new Error(
      `DRIFT: ui/src/board/Board.tsx PHASE_C (phase accent colors) is missing a ` +
        `color for phase(s) ${JSON.stringify(missing)} present in ${SOT}. Add a ` +
        `color entry. (PHASE_C legitimately also includes ancillary "${ANCILLARY_PHASES.join(
          '", "',
        )}" + display aliases like merge/deploy/done, so extra keys are fine.)`,
    );
  }
  expect(missing).toEqual([]);
});

// ── Requirement 6: PHASE_TO_LINEAR value-space === Board.tsx LINEAR_COLS keys ─
// Every Linear column label the data layer can emit must have a UI column, and
// every UI Linear column must be backed by a label the data layer emits.
test("Board.tsx LINEAR_COLS keys equal the value-space of board-data PHASE_TO_LINEAR", () => {
  const dataLayerLabels = new Set(Object.values(PHASE_TO_LINEAR));
  const uiCols = new Set(linearColsKeys);

  const uiMissing = [...dataLayerLabels].filter((l) => !uiCols.has(l)).sort();
  const dataMissing = [...uiCols].filter((l) => !dataLayerLabels.has(l)).sort();

  if (uiMissing.length > 0 || dataMissing.length > 0) {
    throw new Error(
      `DRIFT between the data layer and the UI's Linear-lens columns ` +
        `(rooted in ${SOT}):\n` +
        (uiMissing.length
          ? `  board-data.mjs PHASE_TO_LINEAR emits label(s) ${JSON.stringify(
              uiMissing,
            )} with NO matching column in Board.tsx LINEAR_COLS.\n`
          : "") +
        (dataMissing.length
          ? `  Board.tsx LINEAR_COLS has column(s) ${JSON.stringify(
              dataMissing,
            )} that board-data.mjs PHASE_TO_LINEAR never produces.\n`
          : "") +
        `Reconcile PHASE_TO_LINEAR values and LINEAR_COLS keys.`,
    );
  }
  expect(uiMissing).toEqual([]);
  expect(dataMissing).toEqual([]);
});
