// config-writer.ts — CTL-1153 (M2): atomic config write + project upsert + validator.
//
// Single home for all write-path concerns for PUT /api/projects/:key:
//   - VALID_HUES / STATEMAP_KEYS allow-lists (server mirrors the UI palette)
//   - atomicWriteJson — tmp+rename, matches signal-writer.ts:91-94 precedent
//   - updateCatalystConfig — generic read-modify-write, THROWS on bad input (NOT fail-open)
//   - upsertProject — PURE config mutator, returns a new config object
//   - validateProjectPatch — PURE validator, returns { ok, patch } or { ok, error }
//   - writeProjectPatch — I/O wrapper the route calls
//
// The write path is INTENTIONALLY fail-CLOSED (unlike the read path which is fail-open).
// A bad hue / unknown field → 400; unknown key → 404; IO error → 500. A silently-dropped
// edit is worse than a visible error for server-authoritative settings.

import { readFileSync, writeFileSync, renameSync } from "fs";

// Server-side mirror of the 8 UI NAMED_COLORS hues (ui/src/lib/color-palette.ts:10).
// The server must NOT import ui/ (excluded from this tsconfig).
// Lockstep comment: update both when the palette changes.
export const VALID_HUES = new Set([
  "blue", "green", "purple", "amber", "red", "teal", "cyan", "lime",
]);

// Canonical 12 phase→state keys (setup-execution-core-states.sh:63-74).
// A per-project stateMap may set any SUBSET; unknown keys are rejected (typo guard).
// The global fallback covers omitted keys.
export const STATEMAP_KEYS = new Set([
  "backlog", "todo", "triage", "research", "planning", "inProgress",
  "verifying", "reviewing", "remediating", "inReview", "done", "canceled",
]);

export interface ProjectPatch {
  name?: string | null;       // null ⇒ clear; undefined ⇒ leave alone
  color?: string | null;
  icon?: string | null;
  stateMap?: Record<string, string> | null;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/**
 * Atomically write JSON to destPath. Uses tmp suffix with pid+timestamp (mirrors
 * signal-writer.ts:91-94 and the catalyst-archive.ts:183-188 pattern).
 * Throws on any write failure.
 */
export function atomicWriteJson(destPath: string, obj: unknown): void {
  const tmp = `${destPath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n");
  renameSync(tmp, destPath);
}

/**
 * Generic atomic read-modify-write of the WHOLE .catalyst/config.json.
 * Reads the file, runs `mutate` on the parsed object, writes back via tmp+rename.
 * THROWS on read/parse errors and on any write failure (NOT fail-open).
 * Preserves every key not touched by `mutate` via structural spread.
 */
export function updateCatalystConfig(
  configPath: string,
  mutate: (config: Record<string, unknown>) => Record<string, unknown>,
): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch (err) {
    throw new Error(
      `Failed to read config at ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Failed to parse config at ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  if (!isRecord(parsed)) {
    throw new Error(`Config at ${configPath} is not a JSON object`);
  }
  const next = mutate(parsed);
  atomicWriteJson(configPath, next);
  return next;
}

/**
 * PURE upsert of a single projects[] entry by key (case-insensitive: "ctl" → "CTL").
 * Returns a NEW config object (structural clone of catalyst+projects only — other
 * sections are shallow-spread and thus preserved).
 *
 * Behavior:
 *  - Unknown key (∉ teams[] AND ∉ existing projects[]) → { ok: false, reason: "unknown-key" }
 *  - First edit: copies vcsRepo from the matching teams[] entry, creates projects[] if absent
 *  - Patch field: undefined ⇒ leave alone; null/"" ⇒ delete the key; value ⇒ set (trimmed)
 *  - color is validated against VALID_HUES (defense-in-depth; validator already gates this)
 *  - stateMap keys validated against STATEMAP_KEYS (unknown key → throws for defense-in-depth)
 */
export function upsertProject(
  config: Record<string, unknown>,
  key: string,
  patch: ProjectPatch,
): { ok: true; config: Record<string, unknown> } | { ok: false; reason: "unknown-key" } {
  const upperKey = key.toUpperCase();

  const catalyst = isRecord(config.catalyst) ? config.catalyst : {};

  // Find the matching teams[] entry to seed vcsRepo on first edit
  const monitor = isRecord(catalyst.monitor) ? catalyst.monitor : {};
  const linearSection = isRecord(monitor.linear) ? monitor.linear : {};
  const teams: Array<{ key: string; vcsRepo: string }> = [];
  if (Array.isArray(linearSection.teams)) {
    for (const t of linearSection.teams) {
      if (isRecord(t) && typeof t.key === "string" && typeof t.vcsRepo === "string") {
        teams.push({ key: t.key.toUpperCase(), vcsRepo: t.vcsRepo });
      }
    }
  }

  // Find or initialize projects[]
  const existing: Array<Record<string, unknown>> = [];
  if (Array.isArray(catalyst.projects)) {
    for (const p of catalyst.projects) {
      if (isRecord(p)) existing.push(p as Record<string, unknown>);
    }
  }

  // Check if key is known (either in teams[] or already in projects[])
  const teamEntry = teams.find((t) => t.key === upperKey);
  const existingEntry = existing.find(
    (p) => typeof p.key === "string" && p.key.toUpperCase() === upperKey,
  );

  if (!teamEntry && !existingEntry) {
    return { ok: false, reason: "unknown-key" };
  }

  // Build the new entry
  const base: Record<string, unknown> = existingEntry
    ? { ...existingEntry }
    : { key: upperKey, vcsRepo: teamEntry?.vcsRepo ?? null };

  // Ensure key is canonical uppercase
  base.key = upperKey;

  // Apply patch fields: undefined=leave, null/""=delete, value=set
  if (patch.name !== undefined) {
    if (patch.name === null || patch.name === "") {
      delete base.name;
    } else {
      const trimmed = patch.name.trim();
      if (trimmed) base.name = trimmed;
    }
  }
  if (patch.color !== undefined) {
    if (patch.color === null || patch.color === "") {
      delete base.color;
    } else {
      if (!VALID_HUES.has(patch.color)) {
        throw new Error(`Invalid hue: ${patch.color}`);
      }
      base.color = patch.color;
    }
  }
  if (patch.icon !== undefined) {
    if (patch.icon === null || patch.icon === "") {
      delete base.icon;
    } else {
      base.icon = patch.icon.trim();
    }
  }
  if (patch.stateMap !== undefined) {
    if (patch.stateMap === null) {
      delete base.stateMap;
    } else {
      // Validate stateMap keys
      for (const k of Object.keys(patch.stateMap)) {
        if (!STATEMAP_KEYS.has(k)) {
          throw new Error(`Unknown stateMap key: ${k}`);
        }
      }
      base.stateMap = { ...patch.stateMap };
    }
  }

  // Rebuild the projects[] array: replace existing entry or append new one
  const nextProjects = existingEntry
    ? existing.map((p) =>
        typeof p.key === "string" && p.key.toUpperCase() === upperKey ? base : p,
      )
    : [...existing, base];

  // Return a structurally cloned config with only catalyst.projects swapped
  const nextCatalyst: Record<string, unknown> = { ...catalyst, projects: nextProjects };
  const nextConfig: Record<string, unknown> = { ...config, catalyst: nextCatalyst };

  return { ok: true, config: nextConfig };
}

/**
 * PURE validator for the PUT /api/projects/:key request body.
 * Returns { ok: true, patch } on success, { ok: false, status: 400, error } on rejection.
 * null is passed through as the CLEAR sentinel (⇒ upsertProject deletes the key).
 * Rejects: non-object, unknown fields (incl. vcsRepo/key), non-string name, blank name,
 * unknown hue, unknown stateMap key, non-string stateMap value.
 */
export function validateProjectPatch(body: unknown):
  | { ok: true; patch: ProjectPatch }
  | { ok: false; status: 400; error: string } {
  if (!isRecord(body)) {
    return { ok: false, status: 400, error: "Request body must be a JSON object" };
  }

  const ALLOWED_FIELDS = new Set(["name", "color", "icon", "stateMap"]);
  for (const field of Object.keys(body)) {
    if (!ALLOWED_FIELDS.has(field)) {
      return { ok: false, status: 400, error: `Unknown field: ${field}` };
    }
  }

  const patch: ProjectPatch = {};

  // name
  if ("name" in body) {
    const v = body.name;
    if (v === null) {
      patch.name = null;
    } else if (typeof v !== "string") {
      return { ok: false, status: 400, error: "name must be a string or null" };
    } else if (v.trim().length === 0) {
      return { ok: false, status: 400, error: "name must not be blank" };
    } else {
      patch.name = v;
    }
  }

  // color
  if ("color" in body) {
    const v = body.color;
    if (v === null) {
      patch.color = null;
    } else if (typeof v !== "string") {
      return { ok: false, status: 400, error: "color must be a string or null" };
    } else if (!VALID_HUES.has(v)) {
      return { ok: false, status: 400, error: `Invalid color: ${v}. Must be one of: ${[...VALID_HUES].join(", ")}` };
    } else {
      patch.color = v;
    }
  }

  // icon
  if ("icon" in body) {
    const v = body.icon;
    if (v === null) {
      patch.icon = null;
    } else if (typeof v !== "string") {
      return { ok: false, status: 400, error: "icon must be a string or null" };
    } else {
      patch.icon = v;
    }
  }

  // stateMap
  if ("stateMap" in body) {
    const v = body.stateMap;
    if (v === null) {
      patch.stateMap = null;
    } else if (!isRecord(v)) {
      return { ok: false, status: 400, error: "stateMap must be a JSON object or null" };
    } else {
      for (const [k, val] of Object.entries(v)) {
        if (!STATEMAP_KEYS.has(k)) {
          return { ok: false, status: 400, error: `Unknown stateMap key: ${k}. Must be one of: ${[...STATEMAP_KEYS].join(", ")}` };
        }
        if (typeof val !== "string") {
          return { ok: false, status: 400, error: `stateMap.${k} must be a string` };
        }
      }
      patch.stateMap = v as Record<string, string>;
    }
  }

  return { ok: true, patch };
}

/**
 * I/O wrapper the route calls: read → upsertProject → write (atomic).
 * THROWS on read/parse/write errors (→ 500). Returns { ok: false, reason: "unknown-key" }
 * when the key doesn't exist in teams[] or projects[] (→ 404). Never writes on unknown-key
 * (throws from inside mutate so updateCatalystConfig never reaches atomicWriteJson).
 */
export function writeProjectPatch(
  configPath: string,
  key: string,
  patch: ProjectPatch,
): { ok: true } | { ok: false; reason: "unknown-key" } {
  try {
    updateCatalystConfig(configPath, (cfg) => {
      const result = upsertProject(cfg, key, patch);
      if (!result.ok) {
        // Throw a tagged error so updateCatalystConfig aborts before atomicWriteJson
        throw Object.assign(new Error("unknown-key"), { code: "unknown-key" });
      }
      return result.config;
    });
  } catch (err) {
    if ((err as { code?: string })?.code === "unknown-key") {
      return { ok: false, reason: "unknown-key" };
    }
    throw err; // re-throw genuine IO errors
  }
  return { ok: true };
}
