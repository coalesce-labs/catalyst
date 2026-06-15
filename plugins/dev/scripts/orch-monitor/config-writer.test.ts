// Unit tests for lib/config-writer.ts (CTL-1154).
// Run: cd plugins/dev/scripts/orch-monitor && bun test config-writer.test.ts

import { describe, it, expect } from "bun:test";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addTeamEntry, removeTeamEntry } from "./lib/config-writer";

// Helpers
function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), "config-writer-test-"));
}

function writeConfig(dir: string, teams: unknown[]): string {
  const configPath = join(dir, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        projectKey: "catalyst",
        catalyst: {
          monitor: {
            linear: { teams },
            github: { repoColors: { ctl: "#ff0000" } },
          },
        },
      },
      null,
      2
    )
  );
  return configPath;
}

function readTeams(configPath: string): unknown[] {
  const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
  if (typeof parsed !== "object" || parsed === null) return [];
  const p = parsed as Record<string, unknown>;
  const catalyst = p.catalyst;
  if (typeof catalyst !== "object" || catalyst === null) return [];
  const monitor = (catalyst as Record<string, unknown>).monitor;
  if (typeof monitor !== "object" || monitor === null) return [];
  const linear = (monitor as Record<string, unknown>).linear;
  if (typeof linear !== "object" || linear === null) return [];
  const teams = (linear as Record<string, unknown>).teams;
  return Array.isArray(teams) ? teams : [];
}

describe("addTeamEntry (CTL-1154)", () => {
  it("appends a new team and preserves sibling config keys + repoColors", () => {
    const dir = makeTmp();
    try {
      const configPath = writeConfig(dir, [
        { key: "CTL", vcsRepo: "coalesce-labs/catalyst" },
      ]);
      addTeamEntry(configPath, { key: "EVR", vcsRepo: "coalesce-labs/evergreen" });

      const teams = readTeams(configPath);
      expect(teams).toHaveLength(2);
      const keys = (teams as { key: string }[]).map((t) => t.key).sort();
      expect(keys).toEqual(["CTL", "EVR"]);

      // sibling keys must survive
      const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
      const p = parsed as Record<string, unknown>;
      expect(p.projectKey).toBe("catalyst");
      const cat = p.catalyst as Record<string, unknown>;
      const mon = cat.monitor as Record<string, unknown>;
      const gh = mon.github as Record<string, unknown>;
      const colors = gh.repoColors as Record<string, unknown>;
      expect(colors.ctl).toBe("#ff0000");

      // must be valid JSON with 2-space indent
      const raw = readFileSync(configPath, "utf8");
      expect(raw).toMatch(/^ {2}"/m); // 2-space indent
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is idempotent on an existing key: updates vcsRepo in place, never duplicates", () => {
    const dir = makeTmp();
    try {
      const configPath = writeConfig(dir, [
        { key: "EVR", vcsRepo: "coalesce-labs/old-repo" },
      ]);
      addTeamEntry(configPath, { key: "EVR", vcsRepo: "coalesce-labs/evergreen" });

      const teams = readTeams(configPath) as { key: string; vcsRepo: string }[];
      expect(teams).toHaveLength(1);
      expect(teams[0].vcsRepo).toBe("coalesce-labs/evergreen");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a blank key", () => {
    const dir = makeTmp();
    try {
      const configPath = writeConfig(dir, []);
      expect(() => addTeamEntry(configPath, { key: "", vcsRepo: "x/y" })).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a vcsRepo without '/'", () => {
    const dir = makeTmp();
    try {
      const configPath = writeConfig(dir, []);
      expect(() =>
        addTeamEntry(configPath, { key: "EVR", vcsRepo: "noslash" })
      ).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates the catalyst.monitor.linear.teams path if absent", () => {
    const dir = makeTmp();
    try {
      const configPath = join(dir, "config.json");
      writeFileSync(configPath, JSON.stringify({ projectKey: "x" }, null, 2));

      addTeamEntry(configPath, { key: "EVR", vcsRepo: "coalesce-labs/evergreen" });

      const teams = readTeams(configPath) as { key: string }[];
      expect(teams).toHaveLength(1);
      expect(teams[0].key).toBe("EVR");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes atomically: no .tmp left behind", () => {
    const dir = makeTmp();
    try {
      const configPath = writeConfig(dir, []);
      addTeamEntry(configPath, { key: "EVR", vcsRepo: "coalesce-labs/evergreen" });
      expect(existsSync(configPath + ".tmp")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("removeTeamEntry (CTL-1154)", () => {
  it("removes the matching key and preserves the rest", () => {
    const dir = makeTmp();
    try {
      const configPath = writeConfig(dir, [
        { key: "CTL", vcsRepo: "coalesce-labs/catalyst" },
        { key: "EVR", vcsRepo: "coalesce-labs/evergreen" },
      ]);
      const removed = removeTeamEntry(configPath, "EVR");
      expect(removed).toBe(true);
      const teams = readTeams(configPath) as { key: string }[];
      expect(teams).toHaveLength(1);
      expect(teams[0].key).toBe("CTL");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is a no-op for an absent key (returns false), config unchanged", () => {
    const dir = makeTmp();
    try {
      const configPath = writeConfig(dir, [
        { key: "CTL", vcsRepo: "coalesce-labs/catalyst" },
      ]);
      const before = readFileSync(configPath, "utf8");
      const removed = removeTeamEntry(configPath, "ZZZ");
      expect(removed).toBe(false);
      expect(readFileSync(configPath, "utf8")).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns true when an entry was removed", () => {
    const dir = makeTmp();
    try {
      const configPath = writeConfig(dir, [
        { key: "CTL", vcsRepo: "coalesce-labs/catalyst" },
      ]);
      expect(removeTeamEntry(configPath, "CTL")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
