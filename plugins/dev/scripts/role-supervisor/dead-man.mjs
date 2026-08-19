// dead-man.mjs — CTL-2000. The OUT-OF-FLEET dead-man alarm.
//
// routing.md: "the out-of-fleet dead-man alarm fires when there is no concierge
// heartbeat AND no channel turn for 30 minutes; it pushes the human once and
// posts on the channel." It is the one thing that notices the concierge is
// dead — "you cannot be the thing that notices you are dead" — so it lives in
// its OWN launchd unit (com.catalyst.dead-man), separate from every fleet role.
//
// The decision is the pure deadManShouldFire in backstop.mjs (fires only when
// BOTH signals are >=30m; a missing signal counts as dead, never as healthy).
// Everything here is fail-open I/O. The human push follows the usage-page
// out-of-fleet pattern: a channel append needs no credentials launchd lacks.
import { existsSync, readFileSync, writeFileSync, renameSync, rmSync, mkdirSync, appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { deadManShouldFire, DEAD_MAN_AFTER_MS } from "./backstop.mjs";
import { roleDir, catalystDir } from "./paths.mjs";
import { readHeartbeat } from "./state.mjs";
import { TARGET } from "../execution-core/escalation-router.mjs";

const LATCH_NAME = ".dead-man-latch.json";
const latchPath = (env) => join(catalystDir(env), "roles", LATCH_NAME);

// The out-of-fleet backstops post to the concierge channel themselves; their own
// posts must NEVER count as a "channel turn" (concierge life) or the alarm would
// re-arm off its own page and fire in a loop. A genuine turn is anyone else.
const OUT_OF_FLEET_AUTHORS = new Set(["dead-man", "holding-sentinel", "stale-pr-rescue", "quiet-fleet"]);

// The "no channel turn" signal, read from a POPULATED source: the concierge
// comms channel itself (catalyst-comms JSONL). heartbeat.last_turn_ts is NOT that
// source — `beat()` defaults it to null and nothing supplies it, so reading it
// left `turnDead` permanently true (the alarm paged on the heartbeat alone and
// its latch could never re-arm). Returns the epoch-ms of the most recent GENUINE
// turn (a message not authored by an out-of-fleet backstop), or null when the
// channel is absent/empty/unreadable — absence is not evidence of life.
function defaultLastChannelTurnMs({ env = process.env } = {}) {
  try {
    const channel = env.CATALYST_CONCIERGE_CHANNEL || "concierge";
    const file = join(catalystDir(env), "comms", "channels", `${channel}.jsonl`);
    const text = readFileSync(file, "utf8");
    let latest = null;
    for (const line of text.split("\n")) {
      const s = line.trim();
      if (!s) continue;
      let msg;
      try {
        msg = JSON.parse(s);
      } catch {
        continue; // a torn/partial append is not a turn
      }
      if (OUT_OF_FLEET_AUTHORS.has(msg?.from)) continue;
      const ms = typeof msg?.ts === "string" ? Date.parse(msg.ts) : typeof msg?.ts === "number" ? msg.ts : NaN;
      if (Number.isFinite(ms) && (latest === null || ms > latest)) latest = ms;
    }
    return latest;
  } catch {
    return null;
  }
}

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

// Post on the shared channel — the fleet-visible half. Best-effort, no creds.
function postOnChannel(body, { env = process.env } = {}) {
  const channel = env.CATALYST_CONCIERGE_CHANNEL || "concierge";
  const comms = fileURLToPath(new URL("../catalyst-comms", import.meta.url));
  const res = spawnSync(comms, ["send", channel, body, "--as", "dead-man", "--type", "attention"], {
    encoding: "utf8",
    timeout: 15_000,
  });
  return res.status === 0;
}

// Push the human — the usage-page out-of-fleet pattern: append to the human-
// watched markdown channel dir (needs no LINEAR_SYNC_* credentials launchd
// cannot see). CATALYST_MD_CHANNELS matches catalyst-account-usage-page.sh.
function defaultPushHuman(body, { env = process.env } = {}) {
  try {
    const dir = env.CATALYST_MD_CHANNELS || join(catalystDir(env), "comms", "md-channels");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "dead-man.md");
    appendFileSync(file, `\n## dead-man alarm — ${new Date(Date.now()).toISOString()}\n${body}\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * One dead-man tick. Reads the concierge heartbeat + its last_turn_ts (the
 * "no channel turn" signal, per state.mjs schema), and on deadManShouldFire
 * pushes the human ONCE (durable per-episode latch) and posts on the channel.
 * A recovered concierge (both signals fresh) clears the latch.
 *
 * `--dry-run` prints what it WOULD do and mutates nothing.
 */
export function runDeadManOnce({
  now = Date.now(),
  dryRun = false,
  env = process.env,
  pushHuman = defaultPushHuman,
  postChannel = postOnChannel,
  lastChannelTurnMs = defaultLastChannelTurnMs,
} = {}) {
  const role = conciergeRole(env);
  const hb = safeHeartbeat(role, env);
  const conciergeHbAgeMs = typeof hb?.ts === "number" ? now - hb.ts : null;
  // Read the channel turn from the POPULATED source (the comms channel), not the
  // never-written heartbeat.last_turn_ts. See defaultLastChannelTurnMs above.
  const turnTs = lastChannelTurnMs({ env });
  const lastChannelTurnAgeMs = typeof turnTs === "number" ? now - turnTs : null;

  const latch = readLatch(env);
  const alreadyPushed = latch?.pushed === true;

  // Re-arm: a demonstrably-alive concierge (BOTH signals fresh) clears the latch.
  const hbFresh = typeof conciergeHbAgeMs === "number" && conciergeHbAgeMs < DEAD_MAN_AFTER_MS;
  const turnFresh = typeof lastChannelTurnAgeMs === "number" && lastChannelTurnAgeMs < DEAD_MAN_AFTER_MS;
  if (alreadyPushed && hbFresh && turnFresh) {
    if (!dryRun) clearLatch(env);
    return { fired: false, recovered: true, conciergeHbAgeMs, lastChannelTurnAgeMs, dry_run: dryRun, checked_at: now };
  }

  const fire = deadManShouldFire({ conciergeHbAgeMs, lastChannelTurnAgeMs, alreadyPushed });
  if (!fire) {
    return { fired: false, recovered: false, conciergeHbAgeMs, lastChannelTurnAgeMs, dry_run: dryRun, checked_at: now };
  }

  // The human is reached as an ASK, not a bare alert (routing.md: "You reach the
  // human only as an ask, with Options and a Default"; "a push is for a
  // decision"). The dead-man is the sanctioned out-of-fleet exception to
  // "escalate inward" — every inward rung (steward, concierge) is by definition
  // down when it fires ("you cannot be the thing that notices you are dead",
  // routing.md L43-46), so it resolves straight to the ladder's terminal rung,
  // TARGET.ASK — the human, framed as a decision, never an ad-hoc page.
  const mins = Math.round(DEAD_MAN_AFTER_MS / 60_000);
  const body =
    `[ask · ${TARGET.ASK}] Dead-man: the concierge (\`${role}\`) has had no heartbeat AND no channel turn for >= ${mins} minutes. ` +
    `The coordination fleet may be down (529 wave).\n` +
    `Decision needed:\n` +
    `  - Options: (a) relaunch the coordination fleet; (b) investigate before relaunch.\n` +
    `  - Default if no reply: (a) relaunch.`;

  if (dryRun) {
    return { fired: true, recovered: false, conciergeHbAgeMs, lastChannelTurnAgeMs, target: TARGET.ASK, would: "ask-human+post-channel", dry_run: true, checked_at: now };
  }

  const pushed = pushHuman(body, { env });
  const posted = postChannel(body, { env });
  // Latch the episode as delivered ONLY when a sink actually accepted the alarm.
  // If BOTH fail (unwritable FS + catalyst-comms absent — the very fleet-wide
  // outage this backstop exists to surface), persist pushed:false so the NEXT
  // tick RE-FIRES rather than treating an undelivered alarm as delivered and
  // going silent forever (Codex P1).
  const delivered = pushed || posted;
  writeLatchAtomic({ pushed: delivered, push_ok: pushed, post_ok: posted, fired_at: now }, env);
  return { fired: true, delivered, recovered: false, pushed, posted, target: TARGET.ASK, conciergeHbAgeMs, lastChannelTurnAgeMs, dry_run: false, checked_at: now };
}
