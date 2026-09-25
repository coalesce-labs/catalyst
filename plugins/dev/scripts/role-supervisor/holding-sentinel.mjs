// holding-sentinel.mjs — CTL-2000. The OUT-OF-FLEET holding-reply sentinel.
//
// routing.md: "the launchd-live sentinel posts the tagged holding reply
// 'steward/<slug> is being restarted' at the 15-minute mark, and the supervisor
// restarts the role." It lives in its OWN launchd unit (com.catalyst.holding-
// sentinel) so a 529 wave that takes the fleet down cannot take it with it. The
// reply is a catalyst.alert.raised event on the shared event log (alarm.mjs,
// CTC-2981), cleared once every restarted role is beating again.
//
// It talks about the ROLE, never about tickets: its job is to reassure the
// thread that the silence is being handled and to kick the supervisor, not to
// touch any ticket's work. The decision itself is the pure shouldPostHoldingReply
// in backstop.mjs; everything here is fail-open I/O.
import { existsSync, readFileSync, writeFileSync, renameSync, rmSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { shouldPostHoldingReply } from "./backstop.mjs";
import { roleDir } from "./paths.mjs";
import { readHeartbeat, readManifest } from "./state.mjs";
import { listRoles } from "./doctor.mjs";
import { emitRoleAlarm, ROLE_ALARM_KIND, alarmRaiseDue, raiseLogged } from "./alarm.mjs";

const LATCH_NAME = ".holding-sentinel-latch.json";
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
  } catch {
    /* fail-open */
  }
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
    return readManifest(role, env)?.scope_active ?? true;
  } catch {
    return true;
  }
}

// The holding reply names the ROLE (routing.md's "steward/<slug> is being
// restarted") on the shared event log — no credentials, launchd-safe.
function defaultPostHoldingReply(role, { env = process.env, now = Date.now() } = {}) {
  const reason = `instrument/holding-sentinel: steward/${role} is being restarted — this thread is being handled; hold for the relaunched role.`;
  return emitRoleAlarm(
    { action: "raised", kind: ROLE_ALARM_KIND.ROLE_RESTARTING, instrument: "holding-sentinel", reason, source: role },
    { env, now },
  );
}

// Clear the fleet-scoped alert once no role is still latched.
function defaultClearHoldingReplies({ env = process.env, now = Date.now() } = {}) {
  return emitRoleAlarm({ action: "cleared", kind: ROLE_ALARM_KIND.ROLE_RESTARTING, instrument: "holding-sentinel" }, { env, now });
}

// Ask launchd to restart the role's SUPERVISOR (which restarts its SDK session).
// `kickstart -k` re-runs the label; best-effort — a missing label / non-macOS
// host just no-ops. The sentinel requests the restart; it does not run the role.
function defaultRequestRestart(role, { env = process.env } = {}) {
  const label = `com.catalyst.role.${role}`;
  const uid = typeof process.getuid === "function" ? process.getuid() : "";
  if (uid === "") return false;
  const res = spawnSync("launchctl", ["kickstart", "-k", `gui/${uid}/${label}`], {
    encoding: "utf8",
    timeout: 10_000,
  });
  return res.status === 0;
}

/**
 * One sentinel tick. For each role: compute silence age from its heartbeat and,
 * on shouldPostHoldingReply, post the holding reply + request a supervisor
 * restart, latched once per silence episode. A role whose heartbeat is fresh
 * again clears its latch (edge re-arm); the LAST latched role to recover clears
 * the alert first, and its latch goes only once that clear is on the log. A
 * still-silent role whose reply the board may no longer see (alarmRaiseDue) gets
 * the reply raised again, without a second restart. Fail-open throughout.
 *
 * `--dry-run` prints what it WOULD do and mutates nothing.
 */
export function runHoldingSentinelOnce({
  now = Date.now(),
  dryRun = false,
  env = process.env,
  postHoldingReply = defaultPostHoldingReply,
  clearHoldingReplies = defaultClearHoldingReplies,
  requestRestart = defaultRequestRestart,
  roles,
} = {}) {
  const all = roles ?? listRoles(env);
  const acted = [];
  const reraised = [];
  const recovered = [];
  for (const role of all) {
    const hb = safeHeartbeat(role, env);
    const silenceMs = typeof hb?.ts === "number" ? now - hb.ts : null;

    // Re-arm: the clear is the complement of the post rule (scope active AND
    // silent for >= 15 minutes), so a fresh heartbeat or a scope that went quiet
    // recovers the role. A MISSING heartbeat does not: the post rule skips it
    // only because there is no measurement, and absence is not evidence of
    // life. The latch is removed after the loop, once any due clear is durable.
    const latched = existsSync(latchPath(role, env));
    const beatingAgain = typeof silenceMs === "number" && !shouldPostHoldingReply({ silenceMs, alreadyPosted: false });
    if (latched && (beatingAgain || !scopeActiveOf(role, env))) {
      recovered.push(role);
      continue;
    }

    // Refresh: a still-latched role whose reply the board may no longer see
    // (alarmRaiseDue) gets it raised again.
    if (latched) {
      const latch = readLatch(role, env);
      if (!alarmRaiseDue(latch, now)) continue;
      if (dryRun) {
        reraised.push({ role, would: "re-raise" });
        continue;
      }
      const ok = postHoldingReply(role, { env, now });
      if (ok) writeLatchAtomic(role, { ...latch, posted: true, ...raiseLogged(true, now) }, env);
      reraised.push({ role, posted: ok });
      continue;
    }

    // Only act on an ACTIVE scope — a role whose scope is quiet does not need a
    // holding reply, matching the quiet-fleet gate.
    if (!scopeActiveOf(role, env)) continue;

    if (!shouldPostHoldingReply({ silenceMs, alreadyPosted: latched })) continue;

    if (dryRun) {
      acted.push({ role, silenceMs, would: "post-holding-reply+restart" });
      continue;
    }
    const posted = postHoldingReply(role, { env, now });
    const restarted = requestRestart(role, { env });
    writeLatchAtomic(role, { role, silence_ms: silenceMs, posted, restart_requested: restarted, posted_at: now, ...raiseLogged(posted, now) }, env);
    acted.push({ role, silenceMs, posted, restarted });
  }
  // Clear the alert only when no other role is still latched, and drop the
  // recovered latches only once that clear is durable. While another role is
  // still latched the alert stands, so the recovered latches go right away.
  let cleared = false;
  if (!dryRun && recovered.length > 0) {
    const othersLatched = all.some((r) => !recovered.includes(r) && existsSync(latchPath(r, env)));
    if (!othersLatched) cleared = clearHoldingReplies({ env, now });
    if (othersLatched || cleared) for (const r of recovered) clearLatch(r, env);
  }
  return { acted, reraised, recovered, cleared, dry_run: dryRun, checked_at: now };
}
