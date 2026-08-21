// paths.mjs — CTL-1994. Where a supervised role's state lives on disk.
//
// Everything a role needs to be restarted is either in Linear, on the channel,
// or in one of these files. Nothing important lives in the process — that is
// the whole design constraint, and it is why a 529 that killed seven lanes on
// 2026-08-18 lost nothing that had been written.
import { homedir } from "node:os";
import { join } from "node:path";

/** CATALYST_DIR must be honoured: launchd does not inherit the installing shell's env. */
export function catalystDir(env = process.env) {
  return env.CATALYST_DIR || join(homedir(), "catalyst");
}

export function rolesRoot(env = process.env) {
  return join(catalystDir(env), "roles");
}

export function roleDir(role, env = process.env) {
  return join(rolesRoot(env), role);
}

export const roleFiles = (role, env = process.env) => {
  const d = roleDir(role, env);
  return {
    dir: d,
    manifest: join(d, "manifest.json"),   // what this role IS (role, scope, skill, brief)
    heartbeat: join(d, "heartbeat.json"), // liveness only — never the record
    lease: join(d, "lease.json"),         // ONE live process per role/scope
    session: join(d, "session.json"),     // the SDK session id, for a warm resume
    counters: join(d, "counters.json"),   // restarts/re-entries, for the storm caps
    log: join(d, "supervisor.log"),
  };
};
