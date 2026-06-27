// config-path.ts — single source of truth for resolving the Layer-1
// (`.catalyst/config.json`) path the monitor reads teams / repoColors / projects
// from. Every default that previously hardcoded `${process.cwd()}/.catalyst/
// config.json` (project-roster's loadProjects, server's projectsConfigPath /
// monitorConfigPath, and resolveProjectConfigPath's env fallthrough) now routes
// through this helper so they cannot drift.
//
// WHY this exists (the cwd-relative bug it fixes): the execution-core daemon
// spawns the monitor with cwd = …/plugins/dev/scripts/execution-core, which has
// NO `.catalyst/config.json`. The old `${cwd}/.catalyst/config.json` default
// therefore resolved to a missing file → readTeams() failed open to [] → zero
// configured teams → GET /api/projects returned only the observed-work repos as
// `source:"unconfigured"` (the nav showed 2 projects instead of the 5 configured
// teams). The deploy DOES export the config path in an env var, so resolution
// must prefer the env over the cwd default.
//
// Precedence (cwd-INDEPENDENT whenever an env var is set):
//   1. CATALYST_CONFIG_FILE — the canonical Layer-1 pointer. This is what the
//      execution-core daemon / deploy sets (and what config.mjs's
//      getCatalystRepoDir + lib/stop-worker.mjs + lib/cross-node-stream.mjs all
//      key on), so it MUST win.
//   2. CATALYST_CONFIG_PATH — the legacy monitor-only var introduced by CTL-1156
//      (resolveProjectConfigPath). Kept for back-compat and honored when present.
//   3. `${cwd}/.catalyst/config.json` — the interactive/dev fallback. Running the
//      monitor from a repo root with neither env set still reads the committed
//      Layer-1 config (which carries the team roster).
// CATALYST_CONFIG_FILE is intentionally preferred over CATALYST_CONFIG_PATH: if a
// deploy sets the canonical var, it wins even when the legacy var is also present.

/**
 * Resolve the Layer-1 `.catalyst/config.json` path, preferring an explicit env
 * pointer over the process cwd. Pure: reads only the supplied `env`/`cwd` (which
 * default to the live process), so it is trivially unit-testable.
 */
export function resolveLayer1ConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string {
  if (env.CATALYST_CONFIG_FILE) return env.CATALYST_CONFIG_FILE;
  if (env.CATALYST_CONFIG_PATH) return env.CATALYST_CONFIG_PATH;
  return `${cwd}/.catalyst/config.json`;
}
