// registry.mjs — the central execution-core project registry (CTL-564).
//
// The registry is the D4 successor to CTL-554's per-repo enrollment records:
// a single registry.json holds { team, repoRoot, eligibleQuery } for every
// execution-core team. Per the D9 cloud guardrail, ALL registry I/O — read and
// write — flows through this module, so the later file → Supabase swap happens
// at one seam. CTL-565 (Part B) rewires the daemon onto listProjects(); this
// ticket only writes the registry (setup tooling), it stays unread by the
// daemon until then.
//
// Schema (~/catalyst/execution-core/registry.json):
//   { "projects": [ { "team": "CTL", "repoRoot": "/abs/path",
//                      "eligibleQuery": { "status": "Ready", ... } } ] }

import {
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getRegistryPath, log } from "./config.mjs";

// listProjects() — every well-formed entry in the registry. Missing file → [].
// Malformed JSON → log.warn + []. An entry missing `team` or `repoRoot` is
// skipped (it cannot be addressed or dispatched), mirroring enrollment.mjs's
// listEnrolledProjects() defensiveness.
export function listProjects() {
  const file = getRegistryPath();
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    // ENOENT — registry not created yet — is the common, non-error case.
    if (err?.code === "ENOENT") return [];
    log.warn({ file, err: err.message }, "skipping malformed execution-core registry");
    return [];
  }
  const entries = Array.isArray(parsed?.projects) ? parsed.projects : [];
  const projects = [];
  for (const entry of entries) {
    if (!entry?.team || !entry?.repoRoot) {
      log.warn({ file }, "skipping registry entry missing team or repoRoot");
      continue;
    }
    if (!existsSync(entry.repoRoot)) {
      // CTL-854: a copied/stale registry can carry a repoRoot absent on this host.
      // Keep the entry (behavior unchanged) but flag the misconfiguration so it is
      // visible instead of failing silently at dispatch time.
      log.warn(
        { file, team: entry.team, repoRoot: entry.repoRoot },
        "registry entry repoRoot does not exist on this host",
      );
    }
    projects.push({
      team: entry.team,
      repoRoot: entry.repoRoot,
      eligibleQuery: entry.eligibleQuery ?? null,
    });
  }
  return projects;
}

// getProjectConfig(team) — the single registry entry for `team`, or null when
// the registry is missing or carries no matching entry.
export function getProjectConfig(team) {
  return listProjects().find((p) => p.team === team) ?? null;
}

// resolveEligibleQuery — normalize a registry entry into the runnable query the
// monitor + linear-query layer needs. The entry's `team` lives at the top level
// (the eligibleQuery object never carries it); this is the single place it is
// merged in and the per-field defaults are applied. `status` defaults to the
// start state "Todo" (CTL-731: "Ready" was removed from Linear 2026-06-02, so
// the old "Ready" default was a latent trap); `triageStatus` to "Triage" (CTL-565).
export function resolveEligibleQuery(entry) {
  const eq = entry?.eligibleQuery ?? {};
  return {
    team: entry?.team ?? null,
    status: eq.status ?? "Todo",
    triageStatus: eq.triageStatus ?? "Triage",
    project: eq.project ?? null,
    label: eq.label ?? null,
    priority: eq.priority ?? null,
  };
}

// upsertProjectEntry — idempotently write a team's registry entry. Creates the
// execution-core/ dir if absent; replaces an entry with a matching `team` in
// place (never duplicates); preserves every other entry. The write is atomic
// (tmp + renameSync, mirroring enrollment.mjs) so listProjects() never observes
// a torn registry. Throws on missing `team`/`repoRoot`.
export function upsertProjectEntry({ team, repoRoot, eligibleQuery } = {}) {
  if (!team || !repoRoot) {
    throw new Error("upsertProjectEntry: team and repoRoot are required");
  }
  const entry = {
    team,
    repoRoot,
    eligibleQuery: eligibleQuery ?? null,
  };
  // Start from the current entries, drop any prior record for this team, then
  // append the fresh one — replace-in-place semantics with no duplicates.
  const projects = listProjects().filter((p) => p.team !== team);
  projects.push(entry);

  const file = getRegistryPath();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ projects }, null, 2));
    renameSync(tmp, file);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* tmp already gone */
    }
    throw err;
  }
  return entry;
}

// --- CLI ---------------------------------------------------------------------
// `registry.mjs list`                              → JSON array of entries
// `registry.mjs get <team>`                        → JSON object or empty
// `registry.mjs upsert --team T --repo-root R --eligible-query JSON`
//
// The setup tooling (setup-execution-core-states.sh) invokes this CLI rather
// than hand-writing registry JSON, keeping the D9 seam single.

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith("--")) {
      throw new Error(`registry.mjs: unexpected argument '${key}'`);
    }
    if (value === undefined) {
      throw new Error(`registry.mjs: flag '${key}' is missing a value`);
    }
    flags[key.slice(2)] = value;
  }
  return flags;
}

function main(argv) {
  const [command, ...rest] = argv;
  switch (command) {
    case "list": {
      process.stdout.write(`${JSON.stringify(listProjects(), null, 2)}\n`);
      return 0;
    }
    case "get": {
      const team = rest[0];
      if (!team) {
        process.stderr.write("registry.mjs get: <team> is required\n");
        return 1;
      }
      const entry = getProjectConfig(team);
      process.stdout.write(entry ? `${JSON.stringify(entry, null, 2)}\n` : "");
      return 0;
    }
    case "upsert": {
      const flags = parseFlags(rest);
      let eligibleQuery = null;
      if (flags["eligible-query"] !== undefined) {
        try {
          eligibleQuery = JSON.parse(flags["eligible-query"]);
        } catch (err) {
          process.stderr.write(`registry.mjs upsert: invalid --eligible-query JSON: ${err.message}\n`);
          return 1;
        }
      }
      const entry = upsertProjectEntry({
        team: flags.team,
        repoRoot: flags["repo-root"],
        eligibleQuery,
      });
      process.stdout.write(`${JSON.stringify(entry, null, 2)}\n`);
      return 0;
    }
    default: {
      process.stderr.write(
        "registry.mjs: usage — list | get <team> | " +
          "upsert --team T --repo-root R [--eligible-query JSON]\n"
      );
      return 1;
    }
  }
}

// CTL-578: portable entrypoint detection. `import.meta.main` is native to Bun
// and Node ≥22.16; older Node treats it as undefined, which under the prior
// `if (import.meta.main)` gate made `node registry.mjs upsert ...` a silent
// no-op. Fall back to comparing the module URL against argv[1] so this CLI
// fires under any runtime that exposes either signal.
const isEntry =
  import.meta.main === true ||
  (typeof import.meta.url === "string" &&
    process.argv[1] &&
    fileURLToPath(import.meta.url) === process.argv[1]);

if (isEntry) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    process.stderr.write(`registry.mjs: ${err.message}\n`);
    process.exit(1);
  }
}
