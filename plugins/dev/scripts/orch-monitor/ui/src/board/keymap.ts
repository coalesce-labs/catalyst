// keymap.ts — THE single static keymap the `?` cheatsheet renders from
// (CTL-916 / DETAIL5, detail design §3.4 keyboard table + §7 `command-menu-keyboard`).
//
// PURE module — React-/jotai-/router-free, so the orch-monitor `bun test` suite
// can assert the cheatsheet documents the keys the Gherkin mandates (j/k, the
// g-chords, the layered Esc, `/`, and ⌘K) directly, with no DOM. The cheatsheet
// overlay (`CommandPalette.tsx` `KeyCheatsheet`) maps this constant to rows; it
// owns no key text of its own, so the documented keys can never drift from the
// classifier in `../hooks/key-nav.ts` that actually binds them.
//
// This is documentation only — it does NOT bind anything. The live bindings are
// `classifyKey` (key-nav.ts) wired through `use-keyboard-nav.ts`; this module is
// the human-readable mirror the operator reads in the `?` overlay. The
// `KEYMAP_BOUND_KEYS` set below is the cross-check that keeps the two in sync
// (keymap.test.ts asserts every classifier action appears here).

/** One documented shortcut: the rendered key(s) + what it does. `keys` is the
 *  display form (already the glyphs the operator sees — `⌘K`, `g t`, `Esc`). */
export interface KeymapEntry {
  /** Display form of the keystroke(s) — e.g. "j / k", "g t", "⌘K", "Esc". */
  keys: string;
  /** One-line description of the behaviour. */
  description: string;
}

/** A titled group of related shortcuts in the cheatsheet. */
export interface KeymapSection {
  title: string;
  entries: KeymapEntry[];
}

/**
 * The keyboard cheatsheet, grouped by concern. Every binding the detail-page
 * classifier (`key-nav.ts`) resolves is documented here — the Gherkin requires
 * j/k, the g-chords, the layered Esc, `/`, and ⌘K to all appear.
 *
 * The order is the operator's mental model: first how you move through a list,
 * then how you jump, then the overlays, then the escape hatch.
 */
export const KEYMAP: readonly KeymapSection[] = [
  {
    title: "Move",
    entries: [
      { keys: "j / k", description: "Next / previous in the list you came from (walks in place)" },
      { keys: "▴ / ▾", description: "Pager up / down — same walk as j / k" },
    ],
  },
  {
    title: "Jump",
    entries: [
      { keys: "g t", description: "From a worker → its parent ticket (on a detail page)" },
      { keys: "g w", description: "Fuzzy go-to a worker (on a detail page)" },
      { keys: "g a", description: "Scroll the lifecycle spine to the active phase node" },
    ],
  },
  {
    title: "Go to",
    entries: [
      { keys: "g h", description: "Inbox" },
      { keys: "g b", description: "Tickets" },
      { keys: "g w", description: "Workers (on non-detail pages)" },
      { keys: "g t", description: "Telemetry (on non-detail pages)" },
      { keys: "g u", description: "Utilization" },
      { keys: "g f", description: "FinOps" },
      { keys: "g o", description: "Fleet Ops" },
      { keys: "g d", description: "DevOps" },
      { keys: "c", description: "Create…" },
    ],
  },
  {
    title: "Overlays",
    entries: [
      { keys: "⌘K", description: "Command palette — go to / copy / Loki / open PR" },
      { keys: "?", description: "This keyboard cheatsheet" },
      { keys: "/", description: "Focus the board search" },
    ],
  },
  {
    title: "Escape",
    entries: [
      {
        keys: "Esc",
        description:
          "Layered: closes an open ⌘K / ? overlay first, then a clean page Esc returns to the list",
      },
    ],
  },
] as const;

/**
 * The bare key tokens the cheatsheet documents, normalised for the cross-check in
 * keymap.test.ts against the live classifier (`key-nav.ts`). Lets the test assert
 * the cheatsheet can never silently drop a key the classifier still binds (or vice
 * versa) — the §3.4 "documents the keys extended in DETAIL1" contract.
 *
 * Tokens are the operator-facing forms: `j`, `k`, `g t`, `g w`, `g a`, `⌘K`,
 * `?`, `/`, `Esc`.
 */
export const KEYMAP_BOUND_KEYS: ReadonlySet<string> = new Set(
  KEYMAP.flatMap((s) => s.entries).flatMap((e) =>
    e.keys.split(" / ").map((k) => k.trim()),
  ),
);
