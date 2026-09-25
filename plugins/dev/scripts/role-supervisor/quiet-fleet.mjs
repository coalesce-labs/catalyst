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
import { join, dirname } from "node:path";
import { LIVENESS, classifyHeartbeat } from "../lib/agent-liveness.mjs";
// resolveSteward is renamed to resolveStewardCore so it does not shadow the
// `resolveSteward` DEP name quietFleetScan takes (CTL-2129).
import { nextEscalationTarget, resolveSteward as resolveStewardCore, TARGET } from "../execution-core/escalation-router.mjs";
import { roleDir } from "./paths.mjs";
import { readHeartbeat, readManifest } from "./state.mjs";
import { listRoles } from "./doctor.mjs";
import { emitRoleAlarm, ROLE_ALARM_KIND, alarmRaiseDue, raiseLogged } from "./alarm.mjs";

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
 * @returns {{pages: Array<{role: string, liveness: string, target: string, tag: string, steward: string|null}>, checked_at: number}}
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
    pages.push({ role, liveness: state, target: t.target, tag: t.tag, steward: t.steward?.role ?? null });
  }
  return { pages, checked_at: now };
}

// ── The looping/launchd shell (NOT unit-tested; exercised via --once --dry-run) ──
// Everything below wires the real reads to the pure scan above. It is fail-open:
// a broken heartbeat read, a missing manifest, or a failed alert append must never
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

// The page goes to the rung the router selected: the steward that owns the silent
// role's scope, else the concierge (a fixed identity), never a human.
//
// ⚠️ CTC-2981: there is NO path that delivers this page INTO a running steward or
// concierge session. The old delivery was a `catalyst-comms --to <role>` post on
// the channel those skills read on resume; the channel is gone, the supervisor
// injects nothing into a live session (sdk-session.mjs sends one prompt per
// session boundary), and no event name carries a role identity for a session to
// wake on. So the page is a catalyst.alert.raised on the shared event log, for
// the board, Loki and the cloud, and it names the selected role (`target` plus
// "→ steward <role>" / "→ concierge" in the reason) so whoever reads it knows who
// must act. One fleet-scoped kind: the board folds alerts per kind, so the
// silent role travels in `source` and the reason.
function defaultPostPage(page, { env = process.env, now = Date.now() } = {}) {
  const to = page.target === TARGET.STEWARD && page.steward ? `steward ${page.steward}` : env.CATALYST_CONCIERGE_ID || "concierge";
  const reason = `${page.tag} → ${to}: role \`${page.role}\` is ${page.liveness} while its scope is active — relaunch it, or raise an ask if the work is ambiguous.`;
  return emitRoleAlarm(
    { action: "raised", kind: ROLE_ALARM_KIND.ROLE_SILENT, instrument: "quiet-fleet", reason, source: page.role, target: page.target },
    { env, now },
  );
}

// Clear the fleet-scoped alert once no role is still latched.
function defaultClearPages({ env = process.env, now = Date.now() } = {}) {
  return emitRoleAlarm({ action: "cleared", kind: ROLE_ALARM_KIND.ROLE_SILENT, instrument: "quiet-fleet" }, { env, now });
}

/**
 * Run one quiet-fleet tick against the real fleet. Pure scan + fail-open I/O.
 *
 * Behavior per role:
 *   - LIVE again, or scope no longer active → clear its latch (edge re-arm), no
 *     page. The LAST latched role
 *     to recover clears the fleet alert first, and its latch goes only once that
 *     clear is on the log, so a failed append retries next tick.
 *   - unhealthy + scope-active + not latched → post one concierge page + latch.
 *   - unhealthy but already latched → nothing (edge-triggered), unless
 *     alarmRaiseDue says the board may no longer see its raise: then raise it
 *     again, without counting a new page.
 *
 * `--dry-run` prints the pages it WOULD send and mutates nothing (no latch, no post).
 *
 * @param {{now?: number, dryRun?: boolean, env?: object, postPage?: Function, clearPages?: Function, roles?: string[]}} [opts]
 */
export function runQuietFleetOnce({ now = Date.now(), dryRun = false, env = process.env, postPage = defaultPostPage, clearPages = defaultClearPages, roles } = {}) {
  const all = roles ?? listRoles(env);

  const resolveSteward = (scope) =>
    resolveStewardCore(scope, { listRoles: () => listRoles(env), readManifest: (r) => readManifest(r, env) });

  // Re-arm: the clear is the exact complement of the page rule (unhealthy AND
  // scope active), so a latched role that is LIVE again, or whose scope went
  // quiet, has recovered. Its latch is removed below, after the fleet alert's
  // clear (when one is due) is durable.
  const recovered = [];
  const stillLatched = [];
  for (const role of all) {
    if (!existsSync(latchPath(role, env))) continue;
    const { state } = classifyHeartbeat(safeHeartbeat(role, env), { now });
    if (state === LIVENESS.LIVE || !scopeActiveOf(role, env)) recovered.push(role);
    else stillLatched.push({ role, liveness: state });
  }

  // Refresh: a still-unhealthy role whose raise the board may no longer see
  // (alarmRaiseDue) is raised again. This does not advance the escalation count.
  const reraised = [];
  for (const { role, liveness } of stillLatched) {
    const latch = readLatch(role, env);
    if (!alarmRaiseDue(latch, now)) continue;
    if (dryRun) {
      reraised.push({ role, would: "re-raise" });
      continue;
    }
    const t = latch?.target && latch?.tag
      ? { target: latch.target, tag: latch.tag, steward: latch.steward ? { role: latch.steward } : null }
      : nextEscalationTarget({ scope: role, priorPages: Math.max(0, (latch?.count ?? 1) - 1), instrument: "quiet-fleet", resolveSteward });
    const ok = postPage({ role, liveness, target: t.target, tag: t.tag, steward: t.steward?.role ?? null }, { env, now });
    if (ok) writeLatchAtomic(role, { ...latch, posted: true, ...raiseLogged(true, now) }, env);
    reraised.push({ role, posted: ok });
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
    resolveSteward,
  });

  const posted = [];
  for (const page of scan.pages) {
    if (dryRun) continue;
    const ok = postPage(page, { env, now });
    const prior = readLatch(page.role, env);
    writeLatchAtomic(page.role, {
      role: page.role,
      liveness: page.liveness,
      count: (prior?.count ?? 0) + 1,
      first_paged_at: prior?.first_paged_at ?? now,
      last_paged_at: now,
      posted: ok,
      target: page.target,
      tag: page.tag,
      steward: page.steward,
      ...raiseLogged(ok, now),
    }, env);
    posted.push({ role: page.role, posted: ok });
  }

  // Clear the fleet alert only when no other role is still latched, and drop the
  // recovered latches only once that clear is durable. While another role is
  // still latched the alert stands, so the recovered latches go right away.
  let cleared = false;
  if (!dryRun && recovered.length > 0) {
    const othersLatched = all.some((r) => !recovered.includes(r) && existsSync(latchPath(r, env)));
    if (!othersLatched) cleared = clearPages({ env, now });
    if (othersLatched || cleared) for (const r of recovered) clearLatch(r, env);
  }

  return { pages: scan.pages, posted, reraised, recovered, cleared, dry_run: dryRun, checked_at: now };
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
