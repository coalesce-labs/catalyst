// doctor.mjs — CTL-1994. The operator's audit surface for supervised roles.
//
// Ryan's rule: "quiet" and "dead" must be a number, not a feeling. This turns
// each role's on-disk state into one row, and a red row NAMES the artifact the
// role should have written — because "role X is unhealthy" is not actionable
// and "role X has not updated its status doc in 3 h" is.
import { readdirSync, existsSync } from "node:fs";
import { classifyHeartbeat, classifyStatusDoc, LIVENESS } from "../lib/agent-liveness.mjs";
import { rolesRoot } from "./paths.mjs";
import { readHeartbeat, readManifest, readLease, readCounters, countLastHour } from "./state.mjs";

export function listRoles(env = process.env) {
  const root = rolesRoot(env);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

/**
 * One row per role. Pure with respect to time: `now` is injectable.
 * `statusDocUpdatedAt` comes from the manifest's last recorded status-doc
 * timestamp — the doc's OWN stamp, not when we last thought about it.
 */
export function roleRow(role, { now = Date.now() } = {}, env = process.env) {
  const manifest = readManifest(role, env);
  const hb = readHeartbeat(role, env);
  const lease = readLease(role, env);
  const counters = readCounters(role, env);

  const live = classifyHeartbeat(hb, { now });
  const scopeActive = manifest?.scope_active ?? true;
  const doc = classifyStatusDoc({ updatedAtMs: manifest?.status_doc_updated_at ?? undefined, now, scopeActive });

  const problems = [];
  if (live.state === LIVENESS.DEAD) problems.push(`heartbeat ${Math.round(live.ageMs / 60000)} min old — the role is dead, not quiet`);
  if (live.state === LIVENESS.MISSING) problems.push("no heartbeat has ever been written — the role never booted, or it cannot write its state dir");
  if (doc.state === "stale") problems.push(`status doc ${Math.round(doc.ageMs / 60000)} min old while the scope is active — it should be written every 90 min`);
  if (doc.state === "missing" && scopeActive) problems.push("no status doc — a scope with work in flight and no status doc reads as unowned");
  if (lease && hb && lease.pid !== hb.pid) problems.push(`lease pid ${lease.pid} does not match the heartbeat pid ${hb.pid} — two processes may hold this role`);

  return {
    role,
    scope: manifest?.scope ?? null,
    pid: hb?.pid ?? null,
    session: hb?.session ?? null,
    liveness: live.state,
    heartbeat_age_min: live.ageMs == null ? null : Math.round(live.ageMs / 60000),
    status_doc: doc.state,
    status_doc_age_min: doc.ageMs == null ? null : Math.round(doc.ageMs / 60000),
    restarts_24h: (counters.restarts ?? []).filter((t) => t >= now - 24 * 3600_000).length,
    restarts_1h: countLastHour(counters, "restart", { now }),
    lease_holder: lease?.pid ?? null,
    last_artifact: hb?.last_artifact ?? null,
    red: problems.length > 0,
    problems,
  };
}

export function report({ now = Date.now() } = {}, env = process.env) {
  const roles = listRoles(env);
  return { roles: roles.map((r) => roleRow(r, { now }, env)), checked_at: now };
}

export function formatReport(rep) {
  if (rep.roles.length === 0) {
    // Not "all clear". No roles configured is a different state from all roles
    // healthy, and printing a green line here would be a false clean result.
    return "role-supervisor: no roles configured (this is not the same as 'all roles healthy')";
  }
  const lines = [`role-supervisor: ${rep.roles.length} role(s)`];
  for (const r of rep.roles) {
    const mark = r.red ? "FAIL" : "pass";
    lines.push(
      `  ${mark}  ${r.role}${r.scope ? `/${r.scope}` : ""}  pid=${r.pid ?? "-"}  liveness=${r.liveness}` +
      `  hb=${r.heartbeat_age_min ?? "-"}m  doc=${r.status_doc}(${r.status_doc_age_min ?? "-"}m)  restarts24h=${r.restarts_24h}`,
    );
    for (const p of r.problems) lines.push(`         ⛔ ${p}`);
  }
  return lines.join("\n");
}

// CLI: `node doctor.mjs [--json]`
if (import.meta.url === `file://${process.argv[1]}`) {
  const rep = report();
  if (process.argv.includes("--json")) console.log(JSON.stringify(rep, null, 2));
  else console.log(formatReport(rep));
  process.exit(rep.roles.some((r) => r.red) ? 1 : 0);
}
