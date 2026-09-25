// dead-man.mjs — CTL-2000. The OUT-OF-FLEET dead-man alarm.
//
// routing.md: "the out-of-fleet dead-man alarm fires when there is no concierge
// heartbeat AND no turn for 30 minutes; it pushes the human once." It is the one
// thing that notices the concierge is dead — "you cannot be the thing that
// notices you are dead" — so it lives in its OWN launchd unit
// (com.catalyst.dead-man), separate from every fleet role.
//
// The decision is the pure deadManShouldFire in backstop.mjs (fires only when
// BOTH signals are >=30m; a missing signal counts as dead, never as healthy).
// Everything here is fail-open I/O. The alarm is a catalyst.alert.raised event on
// the shared event log (alarm.mjs, CTC-2981): it needs no credentials launchd
// lacks, and it is the topic the board and the collector already surface.
import { readFileSync, writeFileSync, renameSync, rmSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { deadManShouldFire, DEAD_MAN_AFTER_MS } from "./backstop.mjs";
import { catalystDir } from "./paths.mjs";
import { readHeartbeat } from "./state.mjs";
import { emitRoleAlarm, ROLE_ALARM_KIND, alarmRaiseDue, raiseLogged } from "./alarm.mjs";
import { TARGET } from "../execution-core/escalation-router.mjs";

const LATCH_NAME = ".dead-man-latch.json";
const latchPath = (env) => join(catalystDir(env), "roles", LATCH_NAME);

function readLatch(env) {
  try {
    return JSON.parse(readFileSync(latchPath(env), "utf8"));
  } catch {
    return null;
  }
}

function writeLatchAtomic(obj, env) {
  const p = latchPath(env);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp.${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`);
  renameSync(tmp, p);
}

function clearLatch(env) {
  try {
    rmSync(latchPath(env));
  } catch {
    /* fail-open */
  }
}

function conciergeRole(env) {
  return env.CATALYST_CONCIERGE_ROLE || "concierge";
}

function safeHeartbeat(role, env) {
  try {
    return readHeartbeat(role, env);
  } catch {
    return null;
  }
}

// The "no turn" signal: the concierge heartbeat's own last_turn_ts, which the
// supervisor records each time the concierge's SDK session completes a model
// turn (supervisor.mjs onTurn, CTC-2981). It used to be read from the
// concierge's catalyst-comms channel, which no process populated. Returns
// epoch-ms, or null when nothing records a turn (a concierge not run under the
// supervisor, or one that has never completed a turn) — and null counts as
// silent in deadManShouldFire.
function defaultLastTurnMs({ env = process.env } = {}) {
  const ts = safeHeartbeat(conciergeRole(env), env)?.last_turn_ts;
  const ms = typeof ts === "string" ? Date.parse(ts) : ts;
  return typeof ms === "number" && Number.isFinite(ms) ? ms : null;
}

/**
 * One dead-man tick. Reads the concierge heartbeat + its last turn, and on
 * deadManShouldFire raises ONE catalyst.alert.raised (durable per-episode latch).
 * When either signal is fresh again the concierge counts as recovered: the
 * alert is cleared, then the latch. While it stays dead,
 * the raise is appended again whenever alarmRaiseDue says the board may no
 * longer see it (pre-upgrade latch, month rollover, or ALARM_REFRESH_MS).
 *
 * `--dry-run` prints what it WOULD do and mutates nothing.
 */
export function runDeadManOnce({
  now = Date.now(),
  dryRun = false,
  env = process.env,
  alarm = emitRoleAlarm,
  lastTurnMs = defaultLastTurnMs,
} = {}) {
  const role = conciergeRole(env);
  const hb = safeHeartbeat(role, env);
  const conciergeHbAgeMs = typeof hb?.ts === "number" ? now - hb.ts : null;
  const turnTs = lastTurnMs({ env });
  const lastTurnAgeMs = typeof turnTs === "number" ? now - turnTs : null;

  const latch = readLatch(env);
  const alreadyPushed = latch?.pushed === true;

  // The human is reached as an ASK, not a bare alert (routing.md: "You reach the
  // human only as an ask, with Options and a Default"; "a push is for a
  // decision"). The dead-man is the sanctioned out-of-fleet exception to
  // "escalate inward" — every inward rung (steward, concierge) is by definition
  // down when it fires ("you cannot be the thing that notices you are dead",
  // routing.md L43-46), so it resolves straight to the ladder's terminal rung,
  // TARGET.ASK — the human, framed as a decision, never an ad-hoc page.
  const mins = Math.round(DEAD_MAN_AFTER_MS / 60_000);
  const body =
    `[ask · ${TARGET.ASK}] Dead-man: the concierge (\`${role}\`) has had no heartbeat AND no turn for >= ${mins} minutes. ` +
    `The coordination fleet may be down (529 wave).\n` +
    `Decision needed:\n` +
    `  - Options: (a) relaunch the coordination fleet; (b) investigate before relaunch.\n` +
    `  - Default if no reply: (a) relaunch.`;

  const raise = () =>
    alarm(
      { action: "raised", kind: ROLE_ALARM_KIND.CONCIERGE_DEAD, instrument: "dead-man", reason: body, source: role, target: TARGET.ASK },
      { env, now },
    );

  // Re-arm: the clear is the exact complement of the raise. The alarm raises when
  // the heartbeat AND the turn are both stale (deadManShouldFire), so it clears
  // as soon as either one is fresh again — otherwise a latched alert would stay
  // up, and keep being refreshed, for a concierge the raise rule calls alive.
  const stillDead = deadManShouldFire({ conciergeHbAgeMs, lastTurnAgeMs, alreadyPushed: false });
  if (alreadyPushed && !stillDead) {
    if (dryRun) {
      return { fired: false, recovered: true, cleared: false, conciergeHbAgeMs, lastTurnAgeMs, would: "clear-alert", dry_run: true, checked_at: now };
    }
    // Keep the latch until the clear is durable: if the append fails, the next
    // tick sees the latch again and retries the clear.
    const cleared = alarm({ action: "cleared", kind: ROLE_ALARM_KIND.CONCIERGE_DEAD, instrument: "dead-man", source: role }, { env, now });
    if (cleared) clearLatch(env);
    return { fired: false, recovered: true, cleared, conciergeHbAgeMs, lastTurnAgeMs, dry_run: false, checked_at: now };
  }

  // Refresh: the alert is still standing, but the board may no longer see its
  // raise (see alarmRaiseDue). Raise it again; this is not a new episode.
  if (alreadyPushed && alarmRaiseDue(latch, now)) {
    if (dryRun) {
      return { fired: false, recovered: false, reraised: false, conciergeHbAgeMs, lastTurnAgeMs, would: "re-raise-alert", dry_run: true, checked_at: now };
    }
    const reraised = raise();
    if (reraised) writeLatchAtomic({ ...latch, ...raiseLogged(true, now) }, env);
    return { fired: false, recovered: false, reraised, conciergeHbAgeMs, lastTurnAgeMs, dry_run: false, checked_at: now };
  }

  const fire = deadManShouldFire({ conciergeHbAgeMs, lastTurnAgeMs, alreadyPushed });
  if (!fire) {
    return { fired: false, recovered: false, conciergeHbAgeMs, lastTurnAgeMs, dry_run: dryRun, checked_at: now };
  }

  if (dryRun) {
    return { fired: true, recovered: false, conciergeHbAgeMs, lastTurnAgeMs, target: TARGET.ASK, would: "raise-alert", dry_run: true, checked_at: now };
  }

  const delivered = raise();
  // Latch the episode as delivered ONLY when the event log accepted the alarm.
  // If the append fails (unwritable FS, the very outage this backstop exists to
  // surface), persist pushed:false so the NEXT tick RE-FIRES rather than treating
  // an undelivered alarm as delivered and going silent forever (Codex P1).
  writeLatchAtomic({ pushed: delivered, fired_at: now, ...raiseLogged(delivered, now) }, env);
  return { fired: true, delivered, recovered: false, target: TARGET.ASK, conciergeHbAgeMs, lastTurnAgeMs, dry_run: false, checked_at: now };
}
