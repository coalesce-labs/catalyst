import { describe, it, expect } from "bun:test";
import {
  freshEntryState,
  DETAIL_ENTRY_DEFAULTS,
  colScrollFor,
  setColScroll,
} from "./detail-entry-state";

describe("CTL-1206 — per-column scroll map on the entry state", () => {
  it("freshEntryState starts with an empty colScrollY map", () => {
    expect(freshEntryState().colScrollY).toEqual({});
  });

  it("DETAIL_ENTRY_DEFAULTS includes an empty colScrollY map", () => {
    expect(DETAIL_ENTRY_DEFAULTS.colScrollY).toEqual({});
  });

  it("each freshEntryState returns an independent colScrollY object", () => {
    const a = freshEntryState();
    a.colScrollY["PR"] = 42;
    expect(freshEntryState().colScrollY).toEqual({}); // no shared reference
  });

  it("colScrollFor returns 0 for an unseen column", () => {
    expect(colScrollFor(freshEntryState(), "PR")).toBe(0);
  });

  it("colScrollFor returns the stored offset for a known column", () => {
    const s = setColScroll(freshEntryState(), "PR", 120);
    expect(colScrollFor(s, "PR")).toBe(120);
  });

  it("setColScroll is immutable and scoped to the one key", () => {
    const base = setColScroll(freshEntryState(), "PR", 10);
    const next = setColScroll(base, "Implement", 30);
    expect(base.colScrollY).toEqual({ PR: 10 });            // base untouched
    expect(next.colScrollY).toEqual({ PR: 10, Implement: 30 });
    expect(next).not.toBe(base);
  });

  it("setColScroll overwrites an existing column offset", () => {
    const s = setColScroll(setColScroll(freshEntryState(), "PR", 10), "PR", 80);
    expect(s.colScrollY).toEqual({ PR: 80 });
  });
});
