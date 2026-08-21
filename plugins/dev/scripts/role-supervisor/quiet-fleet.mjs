// quiet-fleet.mjs — CTL-2000. The quiet-fleet alarm: enumerate configured
// roles, classify each via the CTL-1994 heartbeat, and page the CONCIERGE when
// a role is SILENT / DEAD / MISSING while its scope is active.
//
// The paging target comes from the escalation router, so this instrument
// CANNOT reach a human directly (routing.md: "an instrument that reaches the
// human directly is a defect"). Today resolveSteward returns null, so the
// router returns TARGET.CONCIERGE — the alarm pages the concierge, a fixed
// identity, which is exactly the contract.
//
// The scan is PURE and node:*-only: all I/O (heartbeat reads, scope-active,
// prior-page counts, latch state) is injected. The looping/launchd shell that
// wires the real reads lives in cli.mjs's `quiet-fleet` verb.
import { existsSync, readFileSync, writeFileSync, renameSync, rmSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { LIVENESS, classifyHeartbeat } from "../lib/agent-liveness.mjs";
// resolveSteward is renamed to resolveStewardCore so it does not shadow the
// `resolveSteward` DEP name quietFleetScan takes (CTL-2129).
import { nextEscalationTarget, resolveSteward as resolveStewardCore } from "../execution-core/escalation-router.mjs";
import { roleDir } from "./paths.mjs";
import { readHeartbeat, readManifest } from "./state.mjs";
import { listRoles } from "./doctor.mjs";

/**
 * Scan `roles` and return the pages that SHOULD be sent this tick.
 *
 * A page is raised for a role iff ALL hold:
 *   - its heartbeat is not LIVE (SILENT/DEAD/MISSING — a missing heartbeat is
 *     never treated as health, matching classifyHeartbeat's fail-closed rule),
 *   - its scope is active (a quiet role with nothing in flight is fine), and
 *   - it is not already latched (edge-triggered: page once per episode, not
 *     every tick).
 *
 * @param {string[]} roles
 * @param {{
 *   now: number,
 *   readHeartbeat: (role: string) => object|null,
 *   scopeActive: (role: string) => boolean,
 *   priorPages: (role: string) => number,
 *   alreadyLatched?: (role: string) => boolean,
 *   resolveSteward?: (scope: string) => object|null,
 * }} deps
 * @returns {{pages: Array<{role: string, liveness: string, target: string, tag: string}>, checked_at: number}}
 */
export function quietFleetScan(roles, { now, readHeartbeat, scopeActive, priorPages, alreadyLatched = () => false, resolveSteward = () => null } = {}) {
  const pages = [];
  for (const role of roles) {
    const { state } = classifyHeartbeat(readHeartbeat(role), { now });
    if (state === LIVENESS.LIVE) continue;
    if (!scopeActive(role)) continue;
    if (alreadyLatched(role)) continue;
    const t = nextEscalationTarget({
      scope: role,
      priorPages: priorPages(role),
      instrument: "quiet-fleet",
      resolveSteward,
    });
    pages.push({ role, liveness: state, target: t.target, tag: t.tag });
  }
  return { pages, checked_at: now };
}

// ── The looping/launchd shell (NOT unit-tested; exercised via --once --dry-run) ──
// Everything below wires the real reads to the pure scan above. It is fail-open:
// a broken heartbeat read, a missing manifest, or a failed comms post must never
// crash the alarm — a silenced alarm is worse than a noisy one.

const LATCH_NAME = ".quiet-fleet-latch.json";
const latchPath = (role, env) => join(roleDir(role, env), LATCH_NAME);

function readLatch(role, env) {
  try {
    return JSON.parse(readFileSync(latchPath(role, env), "utf8"));
  } catch {
    return null;
  }
}

function writeLatchAtomic(role, obj, env) {
  const p = latchPath(role, env);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp.${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`);
  renameSync(tmp, p);
}

function clearLatch(role, env) {
  try {
    rmSync(latchPath(role, env));
    return true;
  } catch {
    return false;
  }
}

// The concierge is a FIXED identity — a role going quiet pages the concierge on
// the shared channel, never a human. Channel + identity are overridable so a
// deployment can point them at its coordination channel.
function defaultPostPage(page, { env = process.env } = {}) {
  const channel = env.CATALYST_CONCIERGE_CHANNEL || "concierge";
  const to = env.CATALYST_CONCIERGE_ID || "concierge";
  const comms = fileURLToPath(new URL("../catalyst-comms", import.meta.url));
  const body = `${page.tag}: role \`${page.role}\` is ${page.liveness} while its scope is active — page the steward/relaunch. (quiet-fleet alarm)`;
  const res = spawnSync(comms, ["send", channel, body, "--as", "quiet-fleet", "--to", to, "--type", "attention"], {
    encoding: "utf8",
    timeout: 15_000,
  });
  return res.status === 0;
}

/**
 * Run one quiet-fleet tick against the real fleet. Pure scan + fail-open I/O.
 *
 * Behavior per role:
 *   - LIVE again → clear any latch (edge re-arm), no page.
 *   - unhealthy + scope-active + not latched → post one concierge page + latch.
 *   - unhealthy but already latched → nothing (edge-triggered).
 *
 * `--dry-run` prints the pages it WOULD send and mutates nothing (no latch, no post).
 *
 * @param {{now?: number, dryRun?: boolean, env?: object, postPage?: Function, roles?: string[]}} [opts]
 */
export function runQuietFleetOnce({ now = Date.now(), dryRun = false, env = process.env, postPage = defaultPostPage, roles } = {}) {
  const all = roles ?? listRoles(env);

  // First, re-arm: any role that recovered to LIVE has its latch cleared so the
  // NEXT episode pages again (edge-triggered, not level-triggered).
  const recovered = [];
  for (const role of all) {
    if (!existsSync(latchPath(role, env))) continue;
    const { state } = classifyHeartbeat(safeHeartbeat(role, env), { now });
    if (state === LIVENESS.LIVE) {
      if (!dryRun) clearLatch(role, env);
      recovered.push(role);
    }
  }

  const scan = quietFleetScan(all, {
    now,
    readHeartbeat: (r) => safeHeartbeat(r, env),
    scopeActive: (r) => scopeActiveOf(r, env),
    priorPages: (r) => readLatch(r, env)?.count ?? 0,
    alreadyLatched: (r) => existsSync(latchPath(r, env)),
    // CTL-2129: the registry-backed resolver. A silent role's NAME is not a
    // project scope key, so today this still resolves null → the concierge (the
    // correct role-liveness backstop); it lights up the steward tier the moment a
    // manifest's scopeKeys contains the scanned scope.
    resolveSteward: (scope) =>
      resolveStewardCore(scope, { listRoles: () => listRoles(env), readManifest: (r) => readManifest(r, env) }),
  });

  const posted = [];
  for (const page of scan.pages) {
    if (dryRun) continue;
    const ok = postPage(page, { env });
    const prior = readLatch(page.role, env);
    writeLatchAtomic(page.role, {
      role: page.role,
      liveness: page.liveness,
      count: (prior?.count ?? 0) + 1,
      first_paged_at: prior?.first_paged_at ?? now,
      last_paged_at: now,
      posted: ok,
    }, env);
    posted.push({ role: page.role, posted: ok });
  }

  return { pages: scan.pages, posted, recovered, dry_run: dryRun, checked_at: now };
}

function safeHeartbeat(role, env) {
  try {
    return readHeartbeat(role, env);
  } catch {
    return null;
  }
}

function scopeActiveOf(role, env) {
  try {
    // Same rule doctor.mjs uses: a manifest that does not say otherwise is active.
    return readManifest(role, env)?.scope_active ?? true;
  } catch {
    return true;
  }
}
