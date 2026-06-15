// config-writer.ts — CTL-1154: atomic writer for catalyst.monitor.linear.teams[].
// The identity authority for the project roster (see project-roster.ts readTeams).
// Mirrors upsertProjectEntry()'s atomic tmp+rename so a concurrent reader never
// sees a torn config. Pairs with project-roster.ts's readTeams() (same nesting
// tolerance: tolerates both `{ catalyst: { monitor } }` and bare `{ monitor }`).
import { readFileSync, writeFileSync, renameSync, unlinkSync } from "fs";

export interface TeamEntry {
  key: string;
  vcsRepo: string;
}

function readConfig(configPath: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("config-writer: config root is not an object");
  }
  return parsed as Record<string, unknown>;
}

function atomicWrite(configPath: string, cfg: unknown): void {
  const tmp = `${configPath}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`);
    renameSync(tmp, configPath);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* already gone */
    }
    throw err;
  }
}

// Navigate (and create if absent) the catalyst.monitor.linear.teams[] path.
// Returns the teams array (mutable in-place). Mutates cfg so the whole tree
// can be serialized back by the caller.
function ensureTeams(cfg: Record<string, unknown>): TeamEntry[] {
  // Tolerate bare { monitor } root (no `catalyst` wrapper) same as readTeams().
  // For writes, we always produce the canonical { catalyst: { monitor: ... } } form.
  const root = cfg;
  if (typeof root.catalyst !== "object" || root.catalyst === null) {
    root.catalyst = {};
  }
  const catalyst = root.catalyst as Record<string, unknown>;
  if (typeof catalyst.monitor !== "object" || catalyst.monitor === null) {
    catalyst.monitor = {};
  }
  const monitor = catalyst.monitor as Record<string, unknown>;
  if (typeof monitor.linear !== "object" || monitor.linear === null) {
    monitor.linear = {};
  }
  const linear = monitor.linear as Record<string, unknown>;
  if (!Array.isArray(linear.teams)) {
    linear.teams = [];
  }
  return linear.teams as TeamEntry[];
}

export function addTeamEntry(configPath: string, entry: TeamEntry): void {
  if (!entry?.key?.trim()) {
    throw new Error(
      "config-writer.addTeamEntry: key is required and must be non-blank"
    );
  }
  if (!entry?.vcsRepo?.includes("/")) {
    throw new Error(
      "config-writer.addTeamEntry: vcsRepo must be in owner/repo form"
    );
  }
  const cfg = readConfig(configPath);
  const teams = ensureTeams(cfg);
  const next = teams.filter((t) => t.key !== entry.key.trim());
  next.push({ key: entry.key.trim(), vcsRepo: entry.vcsRepo.trim() });
  // Write the updated array back into the same slot ensureTeams navigated to.
  const linear = (
    (cfg.catalyst as Record<string, unknown>).monitor as Record<string, unknown>
  ).linear as Record<string, unknown>;
  linear.teams = next;
  atomicWrite(configPath, cfg);
}

export function removeTeamEntry(configPath: string, key: string): boolean {
  const cfg = readConfig(configPath);
  const teams = ensureTeams(cfg);
  const next = teams.filter((t) => t.key !== key);
  if (next.length === teams.length) return false;
  const linear = (
    (cfg.catalyst as Record<string, unknown>).monitor as Record<string, unknown>
  ).linear as Record<string, unknown>;
  linear.teams = next;
  atomicWrite(configPath, cfg);
  return true;
}
