// repo-icons.test.ts — unit tests for CTL-961 repo icon pure logic.
// No DOM, no React — pure function tests.
import { describe, it, expect } from "bun:test";
import {
  parseIconResponse,
  readIconOverride,
  writeIconOverride,
  clearIconOverride,
  REPO_ICON_KEY_PREFIX,
  LUCIDE_ICON_OPTIONS,
  type RepoIconApiResponse,
  type RepoIconOverride,
} from "./repo-icons";

// ── LUCIDE_ICON_OPTIONS ───────────────────────────────────────────────────────

describe("LUCIDE_ICON_OPTIONS", () => {
  it("has at least 10 options", () => {
    expect(LUCIDE_ICON_OPTIONS.length).toBeGreaterThanOrEqual(10);
  });

  it("contains no duplicates", () => {
    expect(new Set(LUCIDE_ICON_OPTIONS).size).toBe(LUCIDE_ICON_OPTIONS.length);
  });
});

// ── parseIconResponse ─────────────────────────────────────────────────────────

describe("parseIconResponse", () => {
  it("returns null when found is false", () => {
    const resp: RepoIconApiResponse = { found: false };
    expect(parseIconResponse(resp)).toBeNull();
  });

  it("returns null when found=true but dataUrl is null", () => {
    const resp: RepoIconApiResponse = {
      found: true,
      path: "favicon.ico",
      downloadUrl: "https://example.com/favicon.ico",
      dataUrl: null,
    };
    expect(parseIconResponse(resp)).toBeNull();
  });

  it("returns dataUrl when found=true and dataUrl is present", () => {
    const resp: RepoIconApiResponse = {
      found: true,
      path: "public/favicon.svg",
      downloadUrl: "https://cdn.example.com/favicon.svg",
      dataUrl: "data:image/svg+xml;base64,abc123",
    };
    expect(parseIconResponse(resp)).toBe("data:image/svg+xml;base64,abc123");
  });

  it("returns null when found=true but dataUrl is undefined", () => {
    const resp: RepoIconApiResponse = {
      found: true,
      path: "favicon.ico",
      downloadUrl: "https://example.com/favicon.ico",
    };
    expect(parseIconResponse(resp)).toBeNull();
  });
});

// ── localStorage helpers ──────────────────────────────────────────────────────

// Minimal in-memory Storage stub for testing without a DOM.
class MemStorage implements Storage {
  private _data: Record<string, string> = {};
  get length() { return Object.keys(this._data).length; }
  key(index: number) { return Object.keys(this._data)[index] ?? null; }
  getItem(k: string) { return this._data[k] ?? null; }
  setItem(k: string, v: string) { this._data[k] = v; }
  removeItem(k: string) { delete this._data[k]; }
  clear() { this._data = {}; }
}

describe("readIconOverride / writeIconOverride / clearIconOverride", () => {
  it("returns null when nothing is stored", () => {
    const storage = new MemStorage();
    expect(readIconOverride("catalyst", storage)).toBeNull();
  });

  it("writes and reads back an override", () => {
    const storage = new MemStorage();
    const override: RepoIconOverride = { icon: "box", color: "#4ea1ff" };
    writeIconOverride("catalyst", override, storage);
    const result = readIconOverride("catalyst", storage);
    expect(result).toEqual(override);
  });

  it("uses the correct localStorage key prefix", () => {
    const storage = new MemStorage();
    writeIconOverride("myrepo", { icon: "layers", color: "#ff0" }, storage);
    expect(storage.getItem(`${REPO_ICON_KEY_PREFIX}myrepo`)).not.toBeNull();
  });

  it("returns null for a different repo key", () => {
    const storage = new MemStorage();
    writeIconOverride("catalyst", { icon: "box", color: "#4ea1ff" }, storage);
    expect(readIconOverride("adva", storage)).toBeNull();
  });

  it("clearIconOverride removes the stored value", () => {
    const storage = new MemStorage();
    writeIconOverride("catalyst", { icon: "box", color: "#4ea1ff" }, storage);
    clearIconOverride("catalyst", storage);
    expect(readIconOverride("catalyst", storage)).toBeNull();
  });

  it("returns null when stored JSON is malformed", () => {
    const storage = new MemStorage();
    storage.setItem(`${REPO_ICON_KEY_PREFIX}bad`, "not-json{{{");
    expect(readIconOverride("bad", storage)).toBeNull();
  });

  it("returns null when stored object is missing icon field", () => {
    const storage = new MemStorage();
    storage.setItem(`${REPO_ICON_KEY_PREFIX}x`, JSON.stringify({ color: "#fff" }));
    expect(readIconOverride("x", storage)).toBeNull();
  });
});
