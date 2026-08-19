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
} = {}) {
  const role = conciergeRole(env);
  const hb = safeHeartbeat(role, env);
  const conciergeHbAgeMs = typeof hb?.ts === "number" ? now - hb.ts : null;
  const lastChannelTurnAgeMs = typeof hb?.last_turn_ts === "number" ? now - hb.last_turn_ts : null;

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

  const body =
    `The concierge (\`${role}\`) has no heartbeat and no channel turn for >= ${Math.round(DEAD_MAN_AFTER_MS / 60_000)} minutes. ` +
    `The coordination fleet may be down (529 wave). A human is needed to relaunch it.`;

  if (dryRun) {
    return { fired: true, recovered: false, conciergeHbAgeMs, lastChannelTurnAgeMs, would: "push-human+post-channel", dry_run: true, checked_at: now };
  }

  const pushed = pushHuman(body, { env });
  const posted = postChannel(body, { env });
  writeLatchAtomic({ pushed: true, push_ok: pushed, post_ok: posted, fired_at: now }, env);
  return { fired: true, recovered: false, pushed, posted, conciergeHbAgeMs, lastChannelTurnAgeMs, dry_run: false, checked_at: now };
}
