import { describe, it, expect } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resolvePublicDir } from "../server";

const fallback = "/committed/public";

describe("resolvePublicDir", () => {
  it("returns fallback when env is unset/empty", () => {
    expect(resolvePublicDir(undefined, fallback)).toBe(fallback);
    expect(resolvePublicDir("", fallback)).toBe(fallback);
  });

  it("returns the env dir when it exists on disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctl1088-"));
    expect(resolvePublicDir(dir, fallback)).toBe(dir);
  });

  it("falls back when the env dir does not exist", () => {
    expect(resolvePublicDir("/no/such/dist/dir", fallback)).toBe(fallback);
  });
});
