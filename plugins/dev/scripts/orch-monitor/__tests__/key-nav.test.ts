// key-nav.test.ts — units for the PURE keystroke classifier behind the extended
// use-keyboard-nav.ts (CTL-912 / DETAIL1, detail design §3.4). Encodes the
// "Keyboard hook is extended, not forked" Gherkin: j/k walk the list, the g-chords
// resolve, ⌘K toggles the palette, and the pre-existing `/`→search + the
// INPUT/TEXTAREA/SELECT input guard still behave unchanged. Pure module → runs in
// the main `bun test` with no jsdom (the hook feeds real KeyboardEvents through
// this exact function, so the keymap can't drift from these units).
import { describe, it, expect } from "bun:test";
import {
  classifyKey,
  isTypingTarget,
  CHORD_WINDOW_MS,
  type KeyEventLike,
} from "../ui/src/hooks/key-nav";

const bare = (key: string, over: Partial<KeyEventLike> = {}): KeyEventLike => ({ key, ...over });

// ── pre-existing bindings are kept verbatim (no regression) ─────────────────
describe("classifyKey — the pre-existing bindings still work unchanged", () => {
  it("`/` focuses the board search and preventDefaults (kept)", () => {
    const a = classifyKey(bare("/"), null, false);
    expect(a.type).toBe("focus-search");
    if (a.type === "focus-search") expect(a.preventDefault).toBe(true);
  });

  it("`?` opens the cheatsheet (kept)", () => {
    expect(classifyKey(bare("?"), null, false).type).toBe("help");
  });

  it("Escape dismisses (kept; the hook owns the layered ordering)", () => {
    expect(classifyKey(bare("Escape"), null, false).type).toBe("escape");
  });

  it("the input-focus guard swallows everything while an INPUT/TEXTAREA/SELECT is focused", () => {
    // CTL-1025: migrated from string tag to TypingTargetLike structural form.
    expect(isTypingTarget({ tagName: "INPUT" })).toBe(true);
    expect(isTypingTarget({ tagName: "TEXTAREA" })).toBe(true);
    expect(isTypingTarget({ tagName: "SELECT" })).toBe(true);
    expect(isTypingTarget({ tagName: "DIV" })).toBe(false);
    // a literal `/` or `j` typed into an input is NOT a shortcut.
    expect(classifyKey(bare("/"), { tagName: "INPUT" }, false).type).toBe("none");
    expect(classifyKey(bare("j"), { tagName: "TEXTAREA" }, false).type).toBe("none");
  });
});

// ── CTL-1049: Escape = back, but NEVER while typing ──────────────────────────
// CTL-1025 unified the guard into lib/typing-target — the classifier takes the
// focused-element shape ({ tagName, isContentEditable }) instead of (tag, flag).
describe("classifyKey — Escape-means-back is input/contentEditable guarded (CTL-1049)", () => {
  it("Escape with focus NOT in a typing target classifies as `escape` (→ history back)", () => {
    expect(classifyKey(bare("Escape"), { tagName: "DIV" }, false).type).toBe("escape");
    expect(classifyKey(bare("Escape"), null, false).type).toBe("escape");
  });

  it("Escape while an INPUT/TEXTAREA is focused is swallowed (`none`) — no navigation", () => {
    // the Gherkin: "Escape means back — focus not in an input". A focused field
    // must keep Escape for its own dismissal (and never silently navigate away).
    expect(classifyKey(bare("Escape"), { tagName: "INPUT" }, false).type).toBe("none");
    expect(classifyKey(bare("Escape"), { tagName: "TEXTAREA" }, false).type).toBe("none");
  });

  it("a focused contentEditable host is a typing target too (Escape swallowed)", () => {
    expect(isTypingTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(isTypingTarget({ tagName: "DIV", isContentEditable: false })).toBe(false);
    // a DIV with isContentEditable=true swallows Escape (and every other shortcut).
    expect(classifyKey(bare("Escape"), { tagName: "DIV", isContentEditable: true }, false).type).toBe("none");
    expect(classifyKey(bare("j"), { tagName: "DIV", isContentEditable: true }, false).type).toBe("none");
    // a plain (non-editable) DIV still lets the shortcuts through.
    expect(classifyKey(bare("Escape"), { tagName: "DIV", isContentEditable: false }, false).type).toBe("escape");
  });
});

// ── new: j/k walk the list in place ─────────────────────────────────────────
describe("classifyKey — j/k walk listContextAtom.ids (NEW)", () => {
  it("`j` → next, `k` → prev, each preventDefaulting", () => {
    const j = classifyKey(bare("j"), null, false);
    const k = classifyKey(bare("k"), null, false);
    expect(j.type).toBe("next");
    expect(k.type).toBe("prev");
    if (j.type === "next") expect(j.preventDefault).toBe(true);
    if (k.type === "prev") expect(k.preventDefault).toBe(true);
  });

  it("does not steal j/k while a modifier is held (so ⌥j stays a browser key)", () => {
    expect(classifyKey(bare("j", { altKey: true }), null, false).type).toBe("none");
  });
});

// ── new: ⌘K toggles the palette, even over an input ─────────────────────────
describe("classifyKey — ⌘K / Ctrl-K toggles the palette (NEW)", () => {
  it("⌘K toggles the palette and preventDefaults", () => {
    const a = classifyKey(bare("k", { metaKey: true }), null, false);
    expect(a.type).toBe("palette");
    if (a.type === "palette") expect(a.preventDefault).toBe(true);
  });

  it("Ctrl-K also toggles the palette (cross-platform)", () => {
    expect(classifyKey(bare("k", { ctrlKey: true }), null, false).type).toBe("palette");
  });

  it("⌘K is reachable EVEN while an input is focused (the one shortcut that pierces the guard)", () => {
    expect(classifyKey(bare("k", { metaKey: true }), { tagName: "INPUT" }, false).type).toBe("palette");
  });

  it("a bare `k` (no modifier) is prev, NOT the palette", () => {
    expect(classifyKey(bare("k"), null, false).type).toBe("prev");
  });
});

// ── new: g-chords ────────────────────────────────────────────────────────────
describe("classifyKey — g-chords g t / g w / g a (NEW)", () => {
  it("a bare `g` arms the chord", () => {
    expect(classifyKey(bare("g"), null, false).type).toBe("chord-start");
  });

  it("with a pending chord, `t`/`w`/`a` resolve to the goto actions", () => {
    expect(classifyKey(bare("t"), null, true).type).toBe("goto-ticket");
    expect(classifyKey(bare("w"), null, true).type).toBe("goto-worker");
    expect(classifyKey(bare("a"), null, true).type).toBe("goto-active");
  });

  it("an unknown second key cancels the chord (no stray action)", () => {
    expect(classifyKey(bare("z"), null, true).type).toBe("none");
  });

  it("the chord does not fire while an input is focused", () => {
    // even with a pending chord, a focused input swallows the second key.
    expect(classifyKey(bare("t"), { tagName: "INPUT" }, true).type).toBe("none");
  });

  it("exposes a chord window constant for the hook timer", () => {
    expect(CHORD_WINDOW_MS).toBeGreaterThan(0);
  });
});
