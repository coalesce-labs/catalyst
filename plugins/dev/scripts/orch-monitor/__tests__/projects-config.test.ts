import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  PALETTE_COLORS,
  paletteHex,
  loadProjectsConfig,
  resolveProjectIdentity,
  computeContrast,
} from "../lib/projects-config";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "projects-config-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("loadProjectsConfig", () => {
  it("returns empty config when file does not exist", () => {
    const cfg = loadProjectsConfig(join(tmpDir, "projects.json"));
    expect(cfg.projects).toEqual({});
  });

  it("returns empty config when file is malformed JSON", () => {
    const p = join(tmpDir, "projects.json");
    writeFileSync(p, "{not valid json");
    const cfg = loadProjectsConfig(p);
    expect(cfg.projects).toEqual({});
  });

  it("parses a valid config", () => {
    const p = join(tmpDir, "projects.json");
    writeFileSync(
      p,
      JSON.stringify({
        projects: {
          catalyst: { label: "Catalyst", color: "amber" },
          "bravo-1": { label: "Bravo", color: "indigo", iconPath: null },
        },
      }),
    );
    const cfg = loadProjectsConfig(p);
    expect(cfg.projects.catalyst).toEqual({
      label: "Catalyst",
      color: "amber",
      iconPath: null,
    });
    expect(cfg.projects["bravo-1"].color).toBe("indigo");
  });

  it("skips entries with invalid color", () => {
    const p = join(tmpDir, "projects.json");
    writeFileSync(
      p,
      JSON.stringify({
        projects: {
          ok: { label: "Ok", color: "amber" },
          bad: { label: "Bad", color: "chartreuse" },
        },
      }),
    );
    const cfg = loadProjectsConfig(p);
    expect(cfg.projects.ok).toBeDefined();
    expect(cfg.projects.bad).toBeUndefined();
  });

  it("skips entries missing label or color", () => {
    const p = join(tmpDir, "projects.json");
    writeFileSync(
      p,
      JSON.stringify({
        projects: {
          nolabel: { color: "rose" },
          nocolor: { label: "NoColor" },
          good: { label: "Good", color: "teal" },
        },
      }),
    );
    const cfg = loadProjectsConfig(p);
    expect(cfg.projects.nolabel).toBeUndefined();
    expect(cfg.projects.nocolor).toBeUndefined();
    expect(cfg.projects.good).toBeDefined();
  });

  it("returns empty when top-level projects is not an object", () => {
    const p = join(tmpDir, "projects.json");
    writeFileSync(p, JSON.stringify({ projects: "oops" }));
    const cfg = loadProjectsConfig(p);
    expect(cfg.projects).toEqual({});
  });
});

describe("resolveProjectIdentity", () => {
  const config = {
    projects: {
      catalyst: { label: "Catalyst", color: "amber" as const },
      bravo: { label: "Bravo", color: "sky" as const, iconPath: null },
    },
  };

  it("resolves by workspace slug when not 'default'", () => {
    const id = resolveProjectIdentity("catalyst", null, config);
    expect(id).toEqual({
      key: "catalyst",
      label: "Catalyst",
      color: "amber",
      iconPath: null,
    });
  });

  it("falls back to detectProjectKey(worktreePath) when workspace is 'default'", () => {
    mkdirSync(join(tmpDir, ".catalyst"), { recursive: true });
    writeFileSync(
      join(tmpDir, ".catalyst", "config.json"),
      JSON.stringify({ catalyst: { projectKey: "bravo" } }),
    );
    const id = resolveProjectIdentity("default", tmpDir, config);
    expect(id?.key).toBe("bravo");
    expect(id?.color).toBe("sky");
  });

  it("returns null when workspace is 'default' and worktreePath missing", () => {
    const id = resolveProjectIdentity("default", null, config);
    expect(id).toBeNull();
  });

  it("returns null when resolved slug is not in config", () => {
    const id = resolveProjectIdentity("unknown-project", null, config);
    expect(id).toBeNull();
  });

  it("returns null when config is empty", () => {
    const id = resolveProjectIdentity("catalyst", null, { projects: {} });
    expect(id).toBeNull();
  });
});

describe("palette contrast", () => {
  // Contrast threshold — WCAG 3:1 applies to large text and UI components.
  const DARK_SURFACE = "#111318"; // orch-monitor ui dark surface-1
  const LIGHT_SURFACE = "#ffffff"; // mockup light surface-1

  for (const color of PALETTE_COLORS) {
    const hex = paletteHex(color);
    it(`${color} (${hex}) passes 3:1 contrast on dark surface`, () => {
      const ratio = computeContrast(hex, DARK_SURFACE);
      expect(ratio).toBeGreaterThanOrEqual(3.0);
    });

    it(`${color} (${hex}) passes 3:1 contrast on light surface`, () => {
      const ratio = computeContrast(hex, LIGHT_SURFACE);
      expect(ratio).toBeGreaterThanOrEqual(3.0);
    });
  }
});
