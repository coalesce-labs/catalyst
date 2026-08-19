// holding-sentinel.mjs — CTL-2000. The OUT-OF-FLEET holding-reply sentinel.
//
// routing.md: "the launchd-live sentinel posts the tagged holding reply
// 'steward/<slug> is being restarted' at the 15-minute mark, and the supervisor
// restarts the role." It lives in its OWN launchd unit (com.catalyst.holding-
// sentinel) so a 529 wave that takes the fleet down cannot take it with it.
//
// It talks about the ROLE, never about tickets: its job is to reassure the
// thread that the silence is being handled and to kick the supervisor, not to
// touch any ticket's work. The decision itself is the pure shouldPostHoldingReply
// in backstop.mjs; everything here is fail-open I/O.
import { existsSync, readFileSync, writeFileSync, renameSync, rmSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { shouldPostHoldingReply } from "./backstop.mjs";
import { roleDir } from "./paths.mjs";
import { readHeartbeat, readManifest } from "./state.mjs";
import { listRoles } from "./doctor.mjs";

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
// restarted"), on the shared channel — no credentials, launchd-safe.
function defaultPostHoldingReply(role, { env = process.env } = {}) {
  const channel = env.CATALYST_CONCIERGE_CHANNEL || "concierge";
  const comms = fileURLToPath(new URL("../catalyst-comms", import.meta.url));
  const body = `instrument/holding-sentinel: steward/${role} is being restarted — this thread is being handled; hold for the relaunched role.`;
  const res = spawnSync(comms, ["send", channel, body, "--as", "holding-sentinel", "--type", "info"], {
    encoding: "utf8",
    timeout: 15_000,
  });
  return res.status === 0;
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
 * again clears its latch (edge re-arm). Fail-open throughout.
 *
 * `--dry-run` prints what it WOULD do and mutates nothing.
 */
export function runHoldingSentinelOnce({
  now = Date.now(),
  dryRun = false,
  env = process.env,
  postHoldingReply = defaultPostHoldingReply,
  requestRestart = defaultRequestRestart,
  roles,
} = {}) {
  const all = roles ?? listRoles(env);
  const acted = [];
  const recovered = [];
  for (const role of all) {
    const hb = safeHeartbeat(role, env);
    const silenceMs = typeof hb?.ts === "number" ? now - hb.ts : null;

    // Re-arm: a fresh heartbeat (silence < threshold) clears the latch so the
    // next silence episode posts again.
    if (existsSync(latchPath(role, env)) && typeof silenceMs === "number" && silenceMs < 15 * 60_000) {
      if (!dryRun) clearLatch(role, env);
      recovered.push(role);
      continue;
    }

    // Only act on an ACTIVE scope — a role whose scope is quiet does not need a
    // holding reply, matching the quiet-fleet gate.
    if (!scopeActiveOf(role, env)) continue;

    const alreadyPosted = existsSync(latchPath(role, env));
    if (!shouldPostHoldingReply({ silenceMs, alreadyPosted })) continue;

    if (dryRun) {
      acted.push({ role, silenceMs, would: "post-holding-reply+restart" });
      continue;
    }
    const posted = postHoldingReply(role, { env });
    const restarted = requestRestart(role, { env });
    writeLatchAtomic(role, { role, silence_ms: silenceMs, posted, restart_requested: restarted, posted_at: now }, env);
    acted.push({ role, silenceMs, posted, restarted });
  }
  return { acted, recovered, dry_run: dryRun, checked_at: now };
}
