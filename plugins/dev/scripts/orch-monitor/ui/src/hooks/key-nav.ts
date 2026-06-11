// key-nav.ts — the PURE keystroke classifier behind use-keyboard-nav.ts
// (CTL-912 / DETAIL1, detail design §3.4). Split out of the React hook (which
// owns the listener + the g-chord timer) so the orch-monitor `bun test` suite
// can unit-test the keymap directly — every Gherkin key behaviour is a pure
// function of (key, modifiers, the input-focus guard, the pending g-chord).
//
// THE EXTENSION IS ADDITIVE: the pre-existing bindings (Escape, `/`→search with
// preventDefault, `?`, and the INPUT/TEXTAREA/SELECT early-return) are encoded
// here UNCHANGED; this only ADDS j/k, ⌘K, and the g-chords (g t / g w / g a).
// `use-keyboard-nav.ts` is the thin effect that feeds events through `classifyKey`
// and dispatches the returned action — so the keymap the operator feels can never
// drift from what key-nav.test.ts locks in.

/** The minimal event shape the classifier reads — a structural subset of the DOM
 *  `KeyboardEvent` so the hook can pass the real event AND the test can pass a
 *  plain object (no jsdom needed). */
export interface KeyEventLike {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

/** The actions the global nav keymap can produce. A discriminated union so the
 *  hook's dispatch is exhaustive and the `g`-chord state is carried explicitly. */
export type KeyAction =
  // pre-existing (kept verbatim) ───────────────────────────────────────────
  | { type: "escape" } // Esc — layered dismiss (hook owns the layers)
  | { type: "focus-search"; preventDefault: true } // `/` — focus board search
  | { type: "help" } // `?` — cheatsheet overlay
  // new for DETAIL1 ──────────────────────────────────────────────────────────
  | { type: "next"; preventDefault: true } // j / ▾ — next in listContext
  | { type: "prev"; preventDefault: true } // k / ▴ — prev in listContext
  | { type: "palette"; preventDefault: true } // ⌘K / Ctrl-K — toggle palette
  | { type: "goto-ticket" } // g t — worker → its ticket
  | { type: "goto-worker" } // g w — fuzzy go-to worker
  | { type: "goto-active" } // g a — scroll spine to the active node
  // chord lifecycle (not dispatched to callbacks; drives the hook's timer) ────
  | { type: "chord-start" } // `g` pressed → arm the chord, await the second key
  | { type: "none" }; // ignored keystroke (incl. all input-focus keys)

/**
 * Whether the focused element is a typing target the keymap must not steal keys
 * from. The pre-existing guard (`use-keyboard-nav.ts:24`) checks INPUT / TEXTAREA
 * / SELECT by tag name; kept byte-for-byte (uppercased tag) so `/`-into-a-textarea
 * and j/k-into-an-input still type a literal character. `tag` is the focused
 * element's `tagName` (the hook reads `document.activeElement?.tagName`).
 *
 * CTL-1049: ALSO treat a contentEditable host as a typing target — `Escape` now
 * means "navigate back" (the Escape=back Gherkin), so it must never fire while the
 * operator is editing a rich-text region. The optional `editable` flag is the
 * focused element's `isContentEditable` (the hook reads `(el as HTMLElement)
 * ?.isContentEditable`); absent/false in the no-DOM test path is a no-op.
 */
export function isTypingTarget(
  tag: string | undefined | null,
  editable?: boolean,
): boolean {
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || editable === true;
}

/** True when no modifier (other than the explicit ⌘/Ctrl handled for the palette)
 *  is held — single-letter shortcuts must not fire while a chord/shortcut modifier
 *  is down, so a browser hotkey like ⌥j is never swallowed as "next". */
function isBareKey(e: KeyEventLike): boolean {
  return !e.metaKey && !e.ctrlKey && !e.altKey;
}

/**
 * Classify a keystroke into a nav action (detail design §3.4 keyboard table).
 *
 * @param e            the keystroke (real DOM event or a plain test object).
 * @param focusedTag   `document.activeElement?.tagName` — the input-focus guard.
 * @param chordPending true when a `g` was pressed within the chord window and we
 *                     are awaiting the second key (the hook owns the timer).
 *
 * Resolution order (each rule is exact):
 *   1. ⌘K / Ctrl-K → toggle palette. Checked FIRST so it works even while an
 *      input is focused (a command palette must always be reachable) — this is
 *      the one shortcut that intentionally pierces the input guard.
 *   2. If a typing target is focused → `none` (the pre-existing guard, kept).
 *   3. A pending `g` chord: the next bare key resolves it — `t`→goto-ticket,
 *      `w`→goto-worker, `a`→goto-active; anything else cancels (`none`).
 *   4. Bare single keys: `j`→next, `k`→prev, `g`→chord-start, `/`→focus-search
 *      (preventDefault, kept), `?`→help (kept), `Escape`→escape (kept).
 *   5. Everything else → `none`.
 *
 * Pure + total: no DOM reads, no throw, no side effects.
 */
export function classifyKey(
  e: KeyEventLike,
  focusedTag: string | undefined | null,
  chordPending: boolean,
  focusedEditable?: boolean,
): KeyAction {
  // 1. ⌘K / Ctrl-K — the palette toggle pierces the input guard (always reachable).
  if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
    return { type: "palette", preventDefault: true };
  }

  // 2. Input-focus guard (pre-existing, kept): swallow nothing while typing.
  //    CTL-1049: a focused contentEditable host counts as a typing target too, so
  //    Escape-means-back can't fire mid-edit.
  if (isTypingTarget(focusedTag, focusedEditable)) return { type: "none" };

  // 3. Resolve a pending `g`-chord with the second bare key.
  if (chordPending && isBareKey(e)) {
    switch (e.key) {
      case "t":
        return { type: "goto-ticket" };
      case "w":
        return { type: "goto-worker" };
      case "a":
        return { type: "goto-active" };
      default:
        return { type: "none" }; // unknown second key cancels the chord
    }
  }

  // 4. Bare single keys (no modifier).
  if (isBareKey(e)) {
    switch (e.key) {
      case "j":
        return { type: "next", preventDefault: true };
      case "k":
        return { type: "prev", preventDefault: true };
      case "g":
        return { type: "chord-start" };
      case "/":
        return { type: "focus-search", preventDefault: true }; // kept (preventDefault)
      case "?":
        return { type: "help" }; // kept
      case "Escape":
        return { type: "escape" }; // kept (hook owns the layered dismiss)
    }
  }

  // Escape can arrive with shift/modifiers on some layouts — honour it regardless
  // so the layered dismiss is never wedged.
  if (e.key === "Escape") return { type: "escape" };

  return { type: "none" };
}

/** The chord window (ms) the hook waits for the second key of a `g`-chord before
 *  it lapses. Exposed so the hook and any test share the one constant. */
export const CHORD_WINDOW_MS = 800;
