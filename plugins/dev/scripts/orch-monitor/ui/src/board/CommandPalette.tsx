// CommandPalette.tsx — the ⌘K command palette + the `?` keyboard cheatsheet, the
// navigation/copy backbone of the detail pages (CTL-916 / DETAIL5, detail design
// §3.2 / §3.4 / §7).
//
// This is the THIN React skin over two pure modules:
//   - palette-actions.ts → the command list (groups + rows + disabled-`soon`)
//   - keymap.ts          → the static cheatsheet content
// The skin owns only the C-token VISUAL layer + the cmdk wiring + the dispatch of
// a fired row's action (navigate / copy / open-url). It re-skins cmdk's shadcn
// semantic-token styling (bg-popover, data-[selected]:bg-accent) to the board's
// inline `C` tokens (surface C.s1, selected row C.s3, mono ids/phases, 2px accent
// caret), while KEEPING cmdk's behavioural primitives — fuzzy filtering, ↑↓/↵
// selection, groups (detail design §3.4 cmdk re-skin flag).
//
// CYAN LICENSE (§3.4): the reserved cyan live glyph appears ONLY on a row whose
// `live` flag is set (a genuinely-live entity, working && active). Selection is a
// 2px accent-blue left bar; the caret is 2px accent-blue. Cyan never on focus /
// selection / decoration.

import { useCallback, useMemo } from "react";
import { useAtom } from "jotai";
import { useNavigate } from "@tanstack/react-router";
import { Command as CommandPrimitive } from "cmdk";
import { paletteOpenAtom, recentlyViewedAtom } from "./nav-store";
import {
  buildPaletteGroups,
  type PaletteActionKind,
  type PaletteFocus,
  type PaletteItem,
} from "./palette-actions";
import { KEYMAP } from "./keymap";
import type { BoardPayload } from "./types";
// CTL-1033: canonical palette. The command palette is an ELEVATED surface (popover
// tier): panel bg → C.s3 + ELEVATED_LIFT; selected row floats one step to C.s4.
import { C, LIVE, ELEVATED_LIFT } from "./board-tokens";

// One stylesheet for the cmdk re-skin: cmdk renders bare DOM (it has NO default
// CSS), so the visual layer is entirely ours. The panel is the elevated surface
// (C.s3 + inset-highlight lift); the selected row lifts to C.s4 with a 2px
// accent-blue left bar; disabled `soon` rows → dimmed + non-interactive; the live
// glyph is the only cyan (LIVE).
const PALETTE_CSS = `
.cat-cmd-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.55); z-index: 60; display: flex; align-items: flex-start; justify-content: center; padding-top: 12vh; }
.cat-cmd { width: min(640px, 92vw); background: ${C.s3}; border: 1px solid ${C.border}; border-radius: 10px; box-shadow: ${ELEVATED_LIFT}; overflow: hidden; color: ${C.fg}; font-family: ${C.mono}; }
.cat-cmd [cmdk-input-wrapper] { display: flex; align-items: center; gap: 8px; padding: 0 12px; border-bottom: 1px solid ${C.border}; border-left: 2px solid ${C.blue}; }
.cat-cmd input { width: 100%; height: 44px; background: transparent; border: 0; outline: none; color: ${C.fg}; font: 13px ${C.mono}; }
.cat-cmd input::placeholder { color: ${C.fgDim}; }
.cat-cmd [cmdk-list] { max-height: 340px; overflow-y: auto; padding: 6px; }
.cat-cmd [cmdk-group-heading] { font: 10px ${C.mono}; letter-spacing: .08em; text-transform: uppercase; color: ${C.fgDim}; padding: 8px 8px 4px; }
.cat-cmd [cmdk-item] { display: flex; align-items: center; gap: 8px; padding: 7px 8px; border-radius: 6px; font: 12px ${C.mono}; color: ${C.fg}; cursor: pointer; border-left: 2px solid transparent; }
.cat-cmd [cmdk-item][data-selected="true"] { background: ${C.s4}; border-left-color: ${C.blue}; }
.cat-cmd [cmdk-item][data-disabled="true"] { color: ${C.fgDim}; cursor: not-allowed; opacity: .6; }
.cat-cmd [cmdk-empty] { padding: 18px; text-align: center; color: ${C.fgDim}; font: 12px ${C.mono}; }
.cat-cmd-meta { margin-left: auto; color: ${C.fgMuted}; font: 11px ${C.mono}; }
.cat-cmd-soon { margin-left: auto; color: ${C.fgDim}; font: 10px ${C.mono}; border: 1px solid ${C.border}; border-radius: 4px; padding: 1px 5px; }
.cat-cmd-live { width: 7px; height: 7px; border-radius: 50%; background: ${LIVE}; flex: 0 0 auto; }
.cat-cmd-sep { height: 1px; margin: 6px 4px; background: ${C.border}; }
`;

// ── action dispatch ──────────────────────────────────────────────────────────
/** A navigate dispatcher injectable for tests; defaults to the TanStack navigate. */
export type PaletteNavigate = (a: { to: "/ticket/$id" | "/worker/$id"; id: string }) => void;

/** Fire a row's action: navigate / copy / open-url. Pure-ish dispatcher so the
 *  row rendering stays declarative. `copy`/`open-url` guard on the browser APIs so
 *  a non-DOM test never throws (they no-op when the API is absent). */
export function dispatchAction(action: PaletteActionKind, navigate: PaletteNavigate): void {
  switch (action.type) {
    case "navigate":
      navigate({ to: action.to, id: action.id });
      break;
    case "copy":
      void navigator.clipboard?.writeText(action.value);
      break;
    case "open-url":
      window.open?.(action.url, "_blank", "noopener,noreferrer");
      break;
  }
}

// ── one palette row ──────────────────────────────────────────────────────────
function Row({ row, onRun }: { row: PaletteItem; onRun: (r: PaletteItem) => void }) {
  return (
    <CommandPrimitive.Item
      key={row.id}
      value={`${row.label} ${row.meta ?? ""}`}
      disabled={row.disabled}
      onSelect={() => onRun(row)}
      data-palette-row={row.id}
      data-live={row.live ? "true" : undefined}
    >
      {/* the reserved cyan glyph — live rows ONLY (never on focus/selection) */}
      {row.live && <span className="cat-cmd-live" aria-hidden />}
      <span>{row.label}</span>
      {row.soon ? (
        <span className="cat-cmd-soon" data-palette-soon>
          soon
        </span>
      ) : (
        row.meta && <span className="cat-cmd-meta">{row.meta}</span>
      )}
    </CommandPrimitive.Item>
  );
}

// ── the ⌘K palette ───────────────────────────────────────────────────────────
export interface CommandPaletteProps {
  /** The resident board payload (the SharedWorker board stream); null until first
   *  frame — the palette opens with only the disabled `soon` honesty rows. */
  payload: BoardPayload | null;
  /** What the palette is opened over (drives copy/Loki/Open-PR/stuck rows). */
  focus: PaletteFocus;
  /** Test seam: override the navigate (defaults to TanStack). */
  navigate?: PaletteNavigate;
}

/**
 * The ⌘K command palette. Open-state is the shared `paletteOpenAtom` (toggled by
 * the shell's ⌘K binding, which saves/restores focus). Renders the
 * `buildPaletteGroups` list through the re-skinned cmdk primitives; firing a row
 * dispatches its action and closes the palette. Esc closes it (the first layer of
 * the §3.4 layered-Escape — the shell's page Esc only fires once this is shut).
 */
export function CommandPalette({ payload, focus, navigate }: CommandPaletteProps) {
  const [open, setOpen] = useAtom(paletteOpenAtom);
  const [recents] = useAtom(recentlyViewedAtom);
  const routerNavigate = useNavigate();

  const nav: PaletteNavigate = useMemo(
    () =>
      navigate ??
      ((a) => {
        if (a.to === "/ticket/$id") {
          void routerNavigate({ to: "/ticket/$id", params: { id: a.id } });
        } else {
          void routerNavigate({ to: "/worker/$id", params: { id: a.id } });
        }
      }),
    [navigate, routerNavigate],
  );

  const groups = useMemo(
    () => (payload ? buildPaletteGroups(payload, focus, recents) : buildPaletteGroups(EMPTY_PAYLOAD, focus, recents)),
    [payload, focus, recents],
  );

  const runRow = useCallback(
    (row: PaletteItem) => {
      if (row.disabled || !row.action) return; // disabled `soon` rows can't activate
      dispatchAction(row.action, nav);
      setOpen(false);
    },
    [nav, setOpen],
  );

  if (!open) return null;

  return (
    <div
      className="cat-cmd-overlay"
      data-command-palette
      role="presentation"
      onMouseDown={(e) => {
        // click on the backdrop (not the dialog) closes — same as Escape's first layer
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <style>{PALETTE_CSS}</style>
      <CommandPrimitive
        className="cat-cmd"
        label="Command palette"
        // keep cmdk's default fuzzy filter + arrow/enter; loop the selection
        loop
        onKeyDown={(e) => {
          // Esc closes this overlay first (the §3.4 layered Escape: the shell's
          // page-Esc is suppressed while the palette is open because this stops
          // propagation up to the global key handler).
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
          }
        }}
      >
        <div cmdk-input-wrapper="">
          <CommandPrimitive.Input autoFocus placeholder="Type a command or ticket id…" />
        </div>
        <CommandPrimitive.List>
          <CommandPrimitive.Empty>No matching commands.</CommandPrimitive.Empty>
          {groups.map((g, gi) => (
            <CommandPrimitive.Group key={g.heading} heading={g.heading}>
              {gi > 0 && <div className="cat-cmd-sep" aria-hidden />}
              {g.items.map((row) => (
                <Row key={row.id} row={row} onRun={runRow} />
              ))}
            </CommandPrimitive.Group>
          ))}
        </CommandPrimitive.List>
      </CommandPrimitive>
    </div>
  );
}

/** A board payload stand-in when the stream hasn't delivered a frame yet — keeps
 *  the palette open-able (only the disabled `soon` honesty rows show). */
const EMPTY_PAYLOAD: BoardPayload = {
  generatedAt: "",
  config: { maxParallel: 0, inFlight: 0, freeSlots: 0, active: 0, working: 0, stuck: 0 },
  repos: [],
  workers: [],
  tickets: [],
  queue: [],
};

// ── the `?` keyboard cheatsheet ──────────────────────────────────────────────
const CHEATSHEET_CSS = `
.cat-keys-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.55); z-index: 60; display: flex; align-items: center; justify-content: center; }
.cat-keys { width: min(520px, 92vw); background: ${C.s3}; border: 1px solid ${C.border}; border-radius: 10px; box-shadow: ${ELEVATED_LIFT}; color: ${C.fg}; font-family: ${C.mono}; padding: 16px 18px; }
.cat-keys h2 { font: 12px ${C.mono}; letter-spacing: .08em; text-transform: uppercase; color: ${C.fgMuted}; margin: 0 0 12px; }
.cat-keys section { margin-bottom: 14px; }
.cat-keys section h3 { font: 10px ${C.mono}; letter-spacing: .08em; text-transform: uppercase; color: ${C.fgDim}; margin: 0 0 6px; }
.cat-keys-row { display: flex; align-items: baseline; gap: 12px; padding: 3px 0; }
.cat-keys-kbd { flex: 0 0 64px; color: ${C.blue}; font: 12px ${C.mono}; }
.cat-keys-desc { color: ${C.fg}; font: 12px ${C.mono}; }
.cat-keys-hint { color: ${C.fgDim}; font: 10px ${C.mono}; margin-top: 8px; }
`;

export interface KeyCheatsheetProps {
  open: boolean;
  onClose: () => void;
}

/**
 * The `?` keyboard cheatsheet overlay. Renders the static `KEYMAP` constant
 * (keymap.ts) — j/k, the g-chords, the layered Esc, `/`, and ⌘K — grouped by
 * section. Esc / backdrop-click close it (the first layer of the layered Escape).
 */
export function KeyCheatsheet({ open, onClose }: KeyCheatsheetProps) {
  if (!open) return null;
  return (
    <div
      className="cat-keys-overlay"
      data-key-cheatsheet
      role="dialog"
      aria-label="Keyboard shortcuts"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
      tabIndex={-1}
    >
      <style>{CHEATSHEET_CSS}</style>
      <div className="cat-keys">
        <h2>Keyboard shortcuts</h2>
        {KEYMAP.map((section) => (
          <section key={section.title}>
            <h3>{section.title}</h3>
            {section.entries.map((e) => (
              <div className="cat-keys-row" key={e.keys} data-key-row={e.keys}>
                <span className="cat-keys-kbd">{e.keys}</span>
                <span className="cat-keys-desc">{e.description}</span>
              </div>
            ))}
          </section>
        ))}
        <div className="cat-keys-hint">Press ? again or Esc to close</div>
      </div>
    </div>
  );
}
