// config-writer.test.ts — CTL-1153 (M2): atomic write, config read-modify-write,
// pure upsert, and validator tests. I/O tests live under __tests__/ (matching
// signal-writer.test.ts). Pure functions (upsertProject, validateProjectPatch)
// are exercised here as well as via the Phase 2 endpoint tests.

import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  atomicWriteJson,
  updateCatalystConfig,
  upsertProject,
  validateProjectPatch,
  writeProjectPatch,
  VALID_HUES,
  STATEMAP_KEYS,
} from "../lib/config-writer";

// ── VALID_HUES / STATEMAP_KEYS ────────────────────────────────────────────────

describe("VALID_HUES (CTL-1153)", () => {
  it("contains exactly the 8 UI palette hues", () => {
    const expected = new Set(["blue", "green", "purple", "amber", "red", "teal", "cyan", "lime"]);
    for (const h of expected) expect(VALID_HUES.has(h)).toBe(true);
    expect(VALID_HUES.size).toBe(8);
  });
});

describe("STATEMAP_KEYS (CTL-1153)", () => {
  it("contains exactly the 12 phase→state keys", () => {
    const expected = ["backlog","todo","triage","research","planning","inProgress",
      "verifying","reviewing","remediating","inReview","done","canceled"];
    for (const k of expected) expect(STATEMAP_KEYS.has(k)).toBe(true);
    expect(STATEMAP_KEYS.size).toBe(12);
  });
});

// ── atomicWriteJson ────────────────────────────────────────────────────────────

describe("atomicWriteJson (CTL-1153)", () => {
  it("writes JSON with 2-space indent + trailing newline, no leftover .tmp files", () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-atomic-"));
    try {
      const p = join(dir, "out.json");
      atomicWriteJson(p, { a: 1 });
      const content = readFileSync(p, "utf8");
      expect(content).toBe(JSON.stringify({ a: 1 }, null, 2) + "\n");
      const tmps = readdirSync(dir).filter((f) => f.includes(".tmp"));
      expect(tmps).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("round-trips: written JSON parses back correctly", () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-atomic-"));
    try {
      const p = join(dir, "out.json");
      const obj = { nested: { a: 1, b: [2, 3] } };
      atomicWriteJson(p, obj);
      expect(JSON.parse(readFileSync(p, "utf8"))).toEqual(obj);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── updateCatalystConfig ───────────────────────────────────────────────────────

const BASE_CONFIG = {
  catalyst: {
    projectKey: "test-workspace",
    linear: { teamKey: "CTL", stateMap: { inReview: "PR", done: "Done" } },
    orchestration: { dispatchMode: "phase-agent" },
    monitor: {
      github: { repoColors: { "coalesce-labs/catalyst": "green" } },
      linear: { teams: [{ key: "CTL", vcsRepo: "coalesce-labs/catalyst" }] },
    },
  },
};

function writeTempConfig(dir: string, obj: unknown = BASE_CONFIG): string {
  const p = join(dir, "config.json");
  writeFileSync(p, JSON.stringify(obj, null, 2) + "\n");
  return p;
}

describe("updateCatalystConfig (CTL-1153)", () => {
  it("throws on missing file", () => {
    expect(() => updateCatalystConfig("/no/such/config.json", (c) => c)).toThrow();
  });

  it("throws on garbage JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-update-"));
    try {
      const p = join(dir, "config.json");
      writeFileSync(p, "not-json");
      expect(() => updateCatalystConfig(p, (c) => c)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves every unrelated section after mutating projects[]", () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-update-"));
    try {
      const p = writeTempConfig(dir);
      const before = JSON.parse(readFileSync(p, "utf8"));
      updateCatalystConfig(p, (c) => {
        const r = upsertProject(c, "CTL", { color: "green" });
        if (!r.ok) throw new Error("upsert unexpectedly failed");
        return r.config as Record<string, unknown>;
      });
      const after = JSON.parse(readFileSync(p, "utf8"));
      // All sibling sections preserved
      expect(after.catalyst.orchestration).toEqual(before.catalyst.orchestration);
      expect(after.catalyst.linear.stateMap).toEqual(before.catalyst.linear.stateMap);
      expect(after.catalyst.monitor.linear.teams).toEqual(before.catalyst.monitor.linear.teams);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("mutate callback that throws aborts before writing", () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-update-"));
    try {
      const p = writeTempConfig(dir);
      const original = readFileSync(p, "utf8");
      expect(() => updateCatalystConfig(p, () => { throw new Error("abort"); })).toThrow("abort");
      expect(readFileSync(p, "utf8")).toBe(original); // file unchanged
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── upsertProject ─────────────────────────────────────────────────────────────

describe("upsertProject (CTL-1153)", () => {
  const cfg = BASE_CONFIG;

  it("unknown key → { ok: false, reason: 'unknown-key' }, input untouched", () => {
    const result = upsertProject(cfg as Record<string, unknown>, "NOPE", { color: "green" });
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toBe("unknown-key");
    expect((cfg as Record<string, unknown>).catalyst).toBeDefined();
  });

  it("first edit creates catalyst.projects[] with vcsRepo copied from teams[]", () => {
    const r = upsertProject(cfg as Record<string, unknown>, "ctl", { color: "green" });
    expect(r.ok).toBe(true);
    const projects = (r as { config: Record<string, unknown> }).config.catalyst as Record<string, unknown>;
    const projectsArr = (projects as Record<string, unknown>).projects as Array<Record<string, unknown>>;
    expect(projectsArr).toHaveLength(1);
    expect(projectsArr[0]).toEqual({ key: "CTL", vcsRepo: "coalesce-labs/catalyst", color: "green" });
  });

  it("input config is NOT mutated (pure function)", () => {
    const r = upsertProject(cfg as Record<string, unknown>, "CTL", { color: "green" });
    expect(r.ok).toBe(true);
    expect((cfg as any).catalyst.projects).toBeUndefined();
  });

  it("partial patch merges: second edit adds name, keeps color", () => {
    const r1 = upsertProject(cfg as Record<string, unknown>, "CTL", { color: "green" });
    expect(r1.ok).toBe(true);
    const r2 = upsertProject((r1 as any).config, "CTL", { name: "Catalyst Core" });
    expect(r2.ok).toBe(true);
    const entry = ((r2 as any).config.catalyst.projects as Array<Record<string, unknown>>)[0];
    expect(entry.color).toBe("green");
    expect(entry.name).toBe("Catalyst Core");
  });

  it("null patch clears the field: name:null removes name", () => {
    const r1 = upsertProject(cfg as Record<string, unknown>, "CTL", { name: "Core", color: "green" });
    expect(r1.ok).toBe(true);
    const r2 = upsertProject((r1 as any).config, "CTL", { name: null });
    expect(r2.ok).toBe(true);
    const entry = ((r2 as any).config.catalyst.projects as Array<Record<string, unknown>>)[0];
    expect(entry.name).toBeUndefined();
    expect(entry.color).toBe("green"); // untouched
  });

  it("stateMap patch: sets stateMap", () => {
    const r = upsertProject(cfg as Record<string, unknown>, "CTL", { stateMap: { inReview: "Code Review" } });
    expect(r.ok).toBe(true);
    const entry = ((r as any).config.catalyst.projects as Array<Record<string, unknown>>)[0];
    expect(entry.stateMap).toEqual({ inReview: "Code Review" });
  });
});

// ── validateProjectPatch ──────────────────────────────────────────────────────

describe("validateProjectPatch (CTL-1153)", () => {
  it("full valid patch → ok with all fields", () => {
    const r = validateProjectPatch({ name: "Catalyst", color: "green", icon: "favicon.ico", stateMap: { inReview: "PR" } });
    expect(r.ok).toBe(true);
    expect((r as any).patch).toEqual({ name: "Catalyst", color: "green", icon: "favicon.ico", stateMap: { inReview: "PR" } });
  });

  it("empty object → ok with empty patch (no-op)", () => {
    expect(validateProjectPatch({}).ok).toBe(true);
    expect((validateProjectPatch({}) as any).patch).toEqual({});
  });

  it("null → 400", () => expect(validateProjectPatch(null).ok).toBe(false));
  it("array → 400", () => expect(validateProjectPatch([]).ok).toBe(false));
  it("string → 400", () => expect(validateProjectPatch("x").ok).toBe(false));

  it("unknown field vcsRepo → 400", () => expect(validateProjectPatch({ vcsRepo: "a/b" }).ok).toBe(false));
  it("unknown field key → 400", () => expect(validateProjectPatch({ key: "CTL" }).ok).toBe(false));
  it("unknown field foo → 400", () => expect(validateProjectPatch({ foo: "bar" }).ok).toBe(false));

  it("non-string name → 400", () => expect(validateProjectPatch({ name: 123 }).ok).toBe(false));
  it("blank name → 400", () => expect(validateProjectPatch({ name: "  " }).ok).toBe(false));
  it("name: null → ok (clear sentinel)", () => {
    const r = validateProjectPatch({ name: null });
    expect(r.ok).toBe(true);
    expect((r as any).patch.name).toBeNull();
  });

  it("bad hue → 400", () => expect(validateProjectPatch({ color: "magenta" }).ok).toBe(false));
  it("color: null → ok (clear sentinel)", () => {
    const r = validateProjectPatch({ color: null });
    expect(r.ok).toBe(true);
    expect((r as any).patch.color).toBeNull();
  });

  it("icon: null → ok (clear sentinel)", () => {
    const r = validateProjectPatch({ icon: null });
    expect(r.ok).toBe(true);
    expect((r as any).patch.icon).toBeNull();
  });

  it("stateMap with unknown key → 400", () => expect(validateProjectPatch({ stateMap: { bogus: "X" } }).ok).toBe(false));
  it("stateMap with non-string value → 400", () => expect(validateProjectPatch({ stateMap: { done: 5 } }).ok).toBe(false));
  it("stateMap: null → ok (clear sentinel)", () => {
    const r = validateProjectPatch({ stateMap: null });
    expect(r.ok).toBe(true);
    expect((r as any).patch.stateMap).toBeNull();
  });
  it("stateMap not an object → 400", () => expect(validateProjectPatch({ stateMap: "yes" }).ok).toBe(false));
});

// ── writeProjectPatch ─────────────────────────────────────────────────────────

describe("writeProjectPatch (CTL-1153)", () => {
  it("unknown key → { ok: false, reason: 'unknown-key' }, no write", () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-write-"));
    try {
      const p = writeTempConfig(dir);
      const original = readFileSync(p, "utf8");
      const r = writeProjectPatch(p, "NOPE", { color: "green" });
      expect(r.ok).toBe(false);
      expect(readFileSync(p, "utf8")).toBe(original);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("happy path: writes the patch and returns { ok: true }", () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-write-"));
    try {
      const p = writeTempConfig(dir);
      const r = writeProjectPatch(p, "CTL", { color: "green", name: "Catalyst Core" });
      expect(r.ok).toBe(true);
      const after = JSON.parse(readFileSync(p, "utf8"));
      expect(after.catalyst.projects).toContainEqual(
        expect.objectContaining({ key: "CTL", vcsRepo: "coalesce-labs/catalyst", color: "green", name: "Catalyst Core" }),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("missing config → throws (fail-closed, not fail-open)", () => {
    expect(() => writeProjectPatch("/no/such/config.json", "CTL", { color: "green" })).toThrow();
  });
});
