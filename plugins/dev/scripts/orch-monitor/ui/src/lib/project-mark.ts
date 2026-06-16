// project-mark.ts — discriminated union for the resolved project mark (CTL-1208).
// Pure types — no React, no side effects.

/** The resolved mark for a project — either a filled Phosphor glyph, a favicon, or nothing. */
export type ProjectMark =
  | { kind: "favicon"; dataUrl: string; selectedPath: string }
  | { kind: "glyph"; name: string }
  | { kind: "none" };
