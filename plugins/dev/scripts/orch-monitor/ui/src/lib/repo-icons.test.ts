// repo-icons.test.ts — unit tests for CTL-961 repo icon pure logic.
// No DOM, no React — pure function tests.
import { describe, it, expect } from "bun:test";
import {
  parseIconResponse,
  parseIconCandidates,
  readIconOverride,
  writeIconOverride,
  clearIconOverride,
  readIconPick,
  writeIconPick,
  clearIconPick,
  REPO_ICON_KEY_PREFIX,
  REPO_ICON_PICK_KEY_PREFIX,
  LUCIDE_ICON_OPTIONS,
  type RepoIconApiResponse,
  type RepoIconOverride,
} from "./repo-icons";

// ── parseIconCandidates ───────────────────────────────────────────────────────

describe("parseIconCandidates", () => {
  it("returns [] when found is false", () => {
    expect(parseIconCandidates({ found: false })).toEqual([]);
  });
  it("returns the candidates array when present", () => {
    const resp: RepoIconApiResponse = {
      found: true, selectedPath: "logo.svg",
      candidates: [
        { path: "logo.svg", format: "svg", downloadUrl: "u1", dataUrl: "data:svg" },
        { path: "favicon.ico", format: "ico", downloadUrl: "u2", dataUrl: "data:ico" },
      ],
    };
    expect(parseIconCandidates(resp).map((c) => c.path)).toEqual(["logo.svg", "favicon.ico"]);
  });
  it("falls back to a single synthesized candidate from legacy fields (svg path)", () => {
    const resp: RepoIconApiResponse = {
      found: true, path: "logo.svg", downloadUrl: "u", dataUrl: "data:svg",
    };
    const cands = parseIconCandidates(resp);
    expect(cands.map((c) => c.path)).toEqual(["logo.svg"]);
    expect(cands[0].format).toBe("svg");
  });
  it("falls back to synthesized ico candidate from legacy fields", () => {
    const resp: RepoIconApiResponse = {
      found: true, path: "favicon.ico", downloadUrl: "u", dataUrl: "data:ico",
    };
    expect(parseIconCandidates(resp)[0].format).toBe("ico");
  });
  it("falls back to synthesized png candidate for unknown extension", () => {
    const resp: RepoIconApiResponse = {
      found: true, path: "apple-touch-icon.png", downloadUrl: "u", dataUrl: null,
    };
    expect(parseIconCandidates(resp)[0].format).toBe("png");
  });
});

// ── readIconPick / writeIconPick / clearIconPick ──────────────────────────────

// Reusable MemStorage (also declared below for the override tests)
class MemStoragePick implements Storage {
  private _data: Record<string, string> = {};
  get length() { return Object.keys(this._data).length; }
  key(index: number) { return Object.keys(this._data)[index] ?? null; }
  getItem(k: string) { return this._data[k] ?? null; }
  setItem(k: string, v: string) { this._data[k] = v; }
  removeItem(k: string) { delete this._data[k]; }
  clear() { this._data = {}; }
}

describe("readIconPick / writeIconPick / clearIconPick", () => {
  it("round-trips a pick path", () => {
    const s = new MemStoragePick();
    writeIconPick("catalyst", "logo.svg", s);
    expect(readIconPick("catalyst", s)).toBe("logo.svg");
  });
  it("returns null for an unset repo", () => {
    expect(readIconPick("adva", new MemStoragePick())).toBeNull();
  });
  it("uses the pick key prefix (distinct from the override prefix)", () => {
    const s = new MemStoragePick();
    writeIconPick("r", "logo.svg", s);
    expect(s.getItem(`${REPO_ICON_PICK_KEY_PREFIX}r`)).not.toBeNull();
    expect(s.getItem(`${REPO_ICON_KEY_PREFIX}r`)).toBeNull();
  });
  it("clearIconPick removes the stored pick", () => {
    const s = new MemStoragePick();
    writeIconPick("r", "logo.svg", s);
    clearIconPick("r", s);
    expect(readIconPick("r", s)).toBeNull();
  });
});

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
