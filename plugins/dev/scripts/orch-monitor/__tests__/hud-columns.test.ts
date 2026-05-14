import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resolveColumns, hasOrchColumn } from "../cli/lib/column-widths.ts";
import { loadHudConfig } from "../lib/monitor-config.ts";
import type { HudColumnConfig } from "../lib/monitor-config.ts";
import { DEFAULT_COLUMN_ORDER } from "../cli/lib/columns.ts";

// ─────────────────────────────────────────────────────────────
// resolveColumns — no config (fallback mode)
// ─────────────────────────────────────────────────────────────

describe("resolveColumns — no config fallback", () => {
  test("returns same column set as hardcoded defaults at 80 cols", () => {
    const cols = resolveColumns(80);
    const ids = cols.map((c) => c.id);
    // STATUS and optional cols hidden at 80; DETAILS always last
    expect(ids).not.toContain("status");
    expect(ids).not.toContain("orch");
    expect(ids).not.toContain("worker");
    expect(ids[ids.length - 1]).toBe("details");
  });

  test("STATUS visible at ≥100 cols", () => {
    expect(resolveColumns(80).some((c) => c.id === "status")).toBe(false);
    expect(resolveColumns(100).some((c) => c.id === "status")).toBe(true);
  });

  test("ORCH visible at ≥160 cols", () => {
    expect(resolveColumns(159).some((c) => c.id === "orch")).toBe(false);
    expect(resolveColumns(160).some((c) => c.id === "orch")).toBe(true);
  });

  test("WORKER visible at ≥180 cols", () => {
    expect(resolveColumns(179).some((c) => c.id === "worker")).toBe(false);
    expect(resolveColumns(180).some((c) => c.id === "worker")).toBe(true);
  });

  test("TIME, REPO, ICON, EVENT, REF, DETAILS always visible", () => {
    const cols = resolveColumns(80);
    for (const id of ["time", "repo", "icon", "event", "ref", "details"] as const) {
      expect(cols.some((c) => c.id === id)).toBe(true);
    }
  });

  test("column order matches DEFAULT_COLUMN_ORDER (visible subset)", () => {
    const cols = resolveColumns(200);
    const ids = cols.map((c) => c.id);
    const expected = DEFAULT_COLUMN_ORDER.filter((id) => ids.includes(id));
    expect(ids).toEqual(expected);
  });

  test("DETAILS is always last", () => {
    for (const width of [80, 120, 160, 200, 300]) {
      const cols = resolveColumns(width);
      expect(cols[cols.length - 1]?.id).toBe("details");
    }
  });

  test("DETAILS has a positive computed width", () => {
    for (const width of [80, 120, 160, 200, 300]) {
      const details = resolveColumns(width).find((c) => c.id === "details");
      expect(details?.width).toBeGreaterThan(0);
    }
  });

  test("non-flex columns have positive widths", () => {
    const cols = resolveColumns(200);
    for (const col of cols.filter((c) => !c.flex)) {
      expect(col.width).toBeGreaterThan(0);
    }
  });

  test("null config behaves same as no config", () => {
    const noConfig = resolveColumns(160);
    const nullConfig = resolveColumns(160, null);
    expect(noConfig.map((c) => c.id)).toEqual(nullConfig.map((c) => c.id));
  });

  test("empty array config behaves same as no config", () => {
    const noConfig = resolveColumns(160);
    const emptyConfig = resolveColumns(160, []);
    expect(noConfig.map((c) => c.id)).toEqual(emptyConfig.map((c) => c.id));
  });
});

// ─────────────────────────────────────────────────────────────
// resolveColumns — config-driven mode
// ─────────────────────────────────────────────────────────────

describe("resolveColumns — config-driven mode", () => {
  test("custom config [{id:details},{id:time}] renders TIME then DETAILS", () => {
    const config: HudColumnConfig[] = [
      { id: "details", visible: true },
      { id: "time", visible: true },
    ];
    const cols = resolveColumns(120, config);
    expect(cols.map((c) => c.id)).toEqual(["time", "details"]);
  });

  test("DETAILS always moved to last regardless of config position", () => {
    const config: HudColumnConfig[] = [
      { id: "details", visible: true },
      { id: "time", visible: true },
      { id: "event", visible: true },
    ];
    const cols = resolveColumns(120, config);
    expect(cols[cols.length - 1]?.id).toBe("details");
  });

  test("visible:false hides a column", () => {
    const config: HudColumnConfig[] = [
      { id: "time", visible: true },
      { id: "event", visible: false },
      { id: "details", visible: true },
    ];
    const cols = resolveColumns(120, config);
    expect(cols.some((c) => c.id === "event")).toBe(false);
    expect(cols.some((c) => c.id === "time")).toBe(true);
  });

  test("only configured columns are rendered (missing IDs not rendered)", () => {
    const config: HudColumnConfig[] = [
      { id: "time" },
      { id: "details" },
    ];
    const cols = resolveColumns(120, config);
    const ids = cols.map((c) => c.id);
    expect(ids).toContain("time");
    expect(ids).toContain("details");
    expect(ids).not.toContain("event");
    expect(ids).not.toContain("repo");
    expect(ids).not.toContain("orch");
  });

  test("unknown id is silently skipped", () => {
    const config: HudColumnConfig[] = [
      { id: "unknown-col" as HudColumnConfig["id"] },
      { id: "time" },
      { id: "details" },
    ];
    const cols = resolveColumns(120, config);
    expect(cols.some((c) => c.id === ("unknown-col" as string))).toBe(false);
    expect(cols.some((c) => c.id === "time")).toBe(true);
  });

  test("custom numeric width overrides computed width", () => {
    const config: HudColumnConfig[] = [
      { id: "time", width: 5 },
      { id: "details" },
    ];
    const cols = resolveColumns(120, config);
    const time = cols.find((c) => c.id === "time");
    expect(time?.width).toBe(5);
  });

  test("width:'auto' uses computed width", () => {
    const config: HudColumnConfig[] = [
      { id: "repo", width: "auto" },
      { id: "details" },
    ];
    const cols = resolveColumns(120, config);
    const repo = cols.find((c) => c.id === "repo");
    // Math.min(14, Math.max(10, Math.floor(120 * 0.07))) = Math.min(14, Math.max(10, 8)) = 10
    expect(repo?.width).toBeGreaterThanOrEqual(10);
  });

  test("minTerminalWidth override hides column below threshold", () => {
    const config: HudColumnConfig[] = [
      { id: "time", minTerminalWidth: 200 },
      { id: "details" },
    ];
    const narrow = resolveColumns(120, config);
    const wide = resolveColumns(200, config);
    expect(narrow.some((c) => c.id === "time")).toBe(false);
    expect(wide.some((c) => c.id === "time")).toBe(true);
  });

  test("orch column can be shown at <160 via config visible:true", () => {
    const config: HudColumnConfig[] = [
      { id: "orch", visible: true },
      { id: "details" },
    ];
    const cols = resolveColumns(80, config);
    expect(cols.some((c) => c.id === "orch")).toBe(true);
  });

  test("column order in output matches config order (excluding details)", () => {
    const config: HudColumnConfig[] = [
      { id: "worker" },
      { id: "time" },
      { id: "orch", visible: true },
      { id: "details" },
    ];
    const cols = resolveColumns(200, config);
    const ids = cols.filter((c) => c.id !== "details").map((c) => c.id);
    expect(ids).toEqual(["worker", "time", "orch"]);
  });

  test("DETAILS has a positive computed width in config mode", () => {
    const config: HudColumnConfig[] = [
      { id: "time" },
      { id: "details" },
    ];
    const details = resolveColumns(120, config).find((c) => c.id === "details");
    expect(details?.width).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────
// hasOrchColumn
// ─────────────────────────────────────────────────────────────

describe("hasOrchColumn", () => {
  test("returns true when orch is in resolved columns", () => {
    const cols = resolveColumns(200);
    expect(hasOrchColumn(cols)).toBe(true);
  });

  test("returns false when orch is not in resolved columns", () => {
    const cols = resolveColumns(80);
    expect(hasOrchColumn(cols)).toBe(false);
  });

  test("returns true when orch is force-enabled via config", () => {
    const cols = resolveColumns(80, [{ id: "orch", visible: true }, { id: "details" }]);
    expect(hasOrchColumn(cols)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// loadHudConfig — file I/O
// ─────────────────────────────────────────────────────────────

describe("loadHudConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "hud-config-test-"));
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test("returns null when file does not exist", () => {
    expect(loadHudConfig(join(tmpDir, "missing.json"))).toBeNull();
  });

  test("returns null when file contains invalid JSON", () => {
    const path = join(tmpDir, "monitor.json");
    writeFileSync(path, "not json");
    expect(loadHudConfig(path)).toBeNull();
  });

  test("returns null when hud key is missing", () => {
    const path = join(tmpDir, "monitor.json");
    writeFileSync(path, JSON.stringify({ other: "data" }));
    expect(loadHudConfig(path)).toBeNull();
  });

  test("returns null when hud.columns is not an array", () => {
    const path = join(tmpDir, "monitor.json");
    writeFileSync(path, JSON.stringify({ hud: { columns: "wrong" } }));
    expect(loadHudConfig(path)).toBeNull();
  });

  test("returns null when columns array is empty", () => {
    const path = join(tmpDir, "monitor.json");
    writeFileSync(path, JSON.stringify({ hud: { columns: [] } }));
    expect(loadHudConfig(path)).toBeNull();
  });

  test("parses a valid columns array", () => {
    const path = join(tmpDir, "monitor.json");
    writeFileSync(path, JSON.stringify({
      hud: {
        columns: [
          { id: "time", visible: true },
          { id: "details", visible: true },
        ],
      },
    }));
    const result = loadHudConfig(path);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(2);
    expect(result![0].id).toBe("time");
    expect(result![1].id).toBe("details");
  });

  test("parses width and minTerminalWidth fields", () => {
    const path = join(tmpDir, "monitor.json");
    writeFileSync(path, JSON.stringify({
      hud: {
        columns: [
          { id: "time", width: 8, minTerminalWidth: 50 },
          { id: "details" },
        ],
      },
    }));
    const result = loadHudConfig(path);
    expect(result![0].width).toBe(8);
    expect(result![0].minTerminalWidth).toBe(50);
  });

  test("parses width:'auto'", () => {
    const path = join(tmpDir, "monitor.json");
    writeFileSync(path, JSON.stringify({
      hud: { columns: [{ id: "repo", width: "auto" }, { id: "details" }] },
    }));
    const result = loadHudConfig(path);
    expect(result![0].width).toBe("auto");
  });

  test("skips entries with unknown id", () => {
    const path = join(tmpDir, "monitor.json");
    writeFileSync(path, JSON.stringify({
      hud: {
        columns: [
          { id: "unknown-column" },
          { id: "time" },
          { id: "details" },
        ],
      },
    }));
    const result = loadHudConfig(path);
    const ids = result!.map((c) => c.id as string);
    expect(ids).not.toContain("unknown-column");
    expect(ids).toContain("time");
  });

  test("skips entries with missing id", () => {
    const path = join(tmpDir, "monitor.json");
    writeFileSync(path, JSON.stringify({
      hud: {
        columns: [
          { visible: true },
          { id: "time" },
          { id: "details" },
        ],
      },
    }));
    const result = loadHudConfig(path);
    expect(result).toHaveLength(2);
  });

  test("end-to-end: loadHudConfig + resolveColumns produces expected column list", () => {
    const path = join(tmpDir, "monitor.json");
    writeFileSync(path, JSON.stringify({
      hud: {
        columns: [
          { id: "details", visible: true },
          { id: "time", visible: true },
        ],
      },
    }));
    const config = loadHudConfig(path);
    const cols = resolveColumns(120, config);
    const ids = cols.map((c) => c.id);
    // DETAILS moves to last; only TIME + DETAILS render
    expect(ids).toEqual(["time", "details"]);
  });
});
