// project-mark.test.ts — unit tests for resolveProjectMark (CTL-1208).
// No DOM, no React — pure function tests.
import { describe, it, expect } from "bun:test";
import { resolveProjectMark } from "./repo-icon-picks-store";
import type { IconCandidate } from "./repo-icons";

const CANDS: IconCandidate[] = [
  { path: "public/favicon.svg", format: "svg", downloadUrl: "u1", dataUrl: "data:svg" },
  { path: "favicon.ico", format: "ico", downloadUrl: "u2", dataUrl: "data:ico" },
];

describe("resolveProjectMark — glyph precedence", () => {
  it("glyph ref in serverIcon → glyph mark even when candidates exist", () => {
    const mark = resolveProjectMark({
      serverIcon: "phosphor:git-fork",
      pick: undefined,
      candidates: CANDS,
      defaultSelectedPath: "public/favicon.svg",
    });
    expect(mark).toEqual({ kind: "glyph", name: "git-fork" });
  });

  it("glyph ref in local pick beats a favicon serverIcon", () => {
    const mark = resolveProjectMark({
      serverIcon: "public/favicon.svg",
      pick: "phosphor:rocket",
      candidates: CANDS,
      defaultSelectedPath: "public/favicon.svg",
    });
    expect(mark).toEqual({ kind: "glyph", name: "rocket" });
  });

  it("glyph ref in local pick beats a glyph in serverIcon", () => {
    const mark = resolveProjectMark({
      serverIcon: "phosphor:star",
      pick: "phosphor:rocket",
      candidates: CANDS,
      defaultSelectedPath: null,
    });
    expect(mark).toEqual({ kind: "glyph", name: "rocket" });
  });
});

describe("resolveProjectMark — favicon fallthrough", () => {
  it("favicon serverIcon path matching candidate → favicon mark", () => {
    const mark = resolveProjectMark({
      serverIcon: "public/favicon.svg",
      pick: undefined,
      candidates: CANDS,
      defaultSelectedPath: null,
    });
    expect(mark).toEqual({ kind: "favicon", dataUrl: "data:svg", selectedPath: "public/favicon.svg" });
  });

  it("no server icon, candidates present → favicon from candidates[0]", () => {
    const mark = resolveProjectMark({
      serverIcon: null,
      pick: undefined,
      candidates: CANDS,
      defaultSelectedPath: null,
    });
    expect(mark).toEqual({ kind: "favicon", dataUrl: "data:svg", selectedPath: "public/favicon.svg" });
  });

  it("local pick as favicon path matching a candidate", () => {
    const mark = resolveProjectMark({
      serverIcon: null,
      pick: "favicon.ico",
      candidates: CANDS,
      defaultSelectedPath: null,
    });
    expect(mark).toEqual({ kind: "favicon", dataUrl: "data:ico", selectedPath: "favicon.ico" });
  });
});

describe("resolveProjectMark — none cases", () => {
  it("no candidates, no server icon → none", () => {
    const mark = resolveProjectMark({
      serverIcon: null,
      pick: undefined,
      candidates: [],
      defaultSelectedPath: null,
    });
    expect(mark).toEqual({ kind: "none" });
  });

  it("stale glyph ref with uncurated name → treated as non-glyph, falls through to favicon/none", () => {
    const mark = resolveProjectMark({
      serverIcon: "phosphor:not-a-real-glyph",
      pick: undefined,
      candidates: [],
      defaultSelectedPath: null,
    });
    expect(mark).toEqual({ kind: "none" });
  });

  it("stale glyph ref falls through to favicon when candidates exist", () => {
    const mark = resolveProjectMark({
      serverIcon: "phosphor:not-a-real-glyph",
      pick: undefined,
      candidates: CANDS,
      defaultSelectedPath: null,
    });
    expect(mark).toEqual({ kind: "favicon", dataUrl: "data:svg", selectedPath: "public/favicon.svg" });
  });
});
