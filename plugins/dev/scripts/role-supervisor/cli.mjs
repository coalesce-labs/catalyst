#!/usr/bin/env node
// cli.mjs — CTL-1994 / CTL-2095. `role-supervisor <verb>`.
//
//   run <role>                  supervise a role in the foreground (launchd runs this)
//   doctor [--json]             one row per role: liveness, status-doc age, restarts
//   stop <role>                 ask a role to write its handoff and exit; it stays down
//   list                        the configured roles
//   quiet-fleet [--once] [--dry-run]   page the concierge when a role goes quiet
//   launch-steward --slug <name> [--scope <str>] [--cwd <dir>] [--dry-run]
//   launch-concierge --human <name> [--scope <str>] [--cwd <dir>] [--dry-run]
//   activity <role> [--in-flight N] [--open-asks N] [--human-newer true|false]
//   complete <role>             mark the role's scope done; supervisor will stop it
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { superviseRole } from "./supervisor.mjs";
import { runSdkSession } from "./sdk-session.mjs";
import { report, formatReport, listRoles } from "./doctor.mjs";
import { writeActivity, markComplete } from "./state.mjs";
import { runQuietFleetOnce } from "./quiet-fleet.mjs";
import { runHoldingSentinelOnce } from "./holding-sentinel.mjs";
import { runDeadManOnce } from "./dead-man.mjs";
import { roleFiles } from "./paths.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// One tick a minute, matching the plist's ThrottleInterval — the alarm never
// touches the daemon hot path or Linear/GitHub.
const QUIET_FLEET_INTERVAL_MS = 60_000;

const __filename = fileURLToPath(import.meta.url);
const SCRIPT_DIR = dirname(__filename);
const INSTALL_SH = join(SCRIPT_DIR, "install.sh");

const [verb, arg] = process.argv.slice(2);

async function main() {
  switch (verb) {
    case "run": {
      if (!arg) die("usage: role-supervisor run <role>");
      const r = await superviseRole(arg, { runSession: runSdkSession });
      console.log(`role-supervisor: ${arg} stopped — ${r.stopped}`);
      return 0;
    }
    case "doctor": {
      const rep = report();
      console.log(process.argv.includes("--json") ? JSON.stringify(rep, null, 2) : formatReport(rep));
      return rep.roles.some((x) => x.red) ? 1 : 0;
    }
    case "stop": {
      if (!arg) die("usage: role-supervisor stop <role>");
      const f = roleFiles(arg);
      if (!existsSync(f.dir)) die(`no such role '${arg}'`);
      mkdirSync(f.dir, { recursive: true });
      writeFileSync(`${f.dir}/stop`, `${new Date().toISOString()}\n`);
      console.log(`role-supervisor: stop requested for ${arg} — it writes its handoff, exits, and stays down until \`run\``);
      return 0;
    }
    case "list": {
      const roles = listRoles();
      // "no roles" is not "all healthy" — say which it is.
      console.log(roles.length ? roles.join("\n") : "(no roles configured)");
      return 0;
    }
    // The three CTL-2000 out-of-fleet / fleet-wide instruments share one loop
    // shape: `--once` runs a single tick (what the plist's StartInterval fires),
    // `--dry-run` prints intended actions and mutates nothing, and with neither
    // flag they loop in the foreground under launchd KeepAlive.
    case "quiet-fleet":
      return runInstrument("quiet-fleet", runQuietFleetOnce);
    case "holding-sentinel":
      return runInstrument("holding-sentinel", runHoldingSentinelOnce);
    case "dead-man":
      return runInstrument("dead-man", runDeadManOnce);

    // CTL-2095: codified launchers. Thin, validated wrappers over install.sh that
    // always use the skill contract and never a hand-written brief.
    case "launch-steward":
      return await handleLaunch({
        argv: process.argv.slice(3),
        requiredSkill: "catalyst-dev:steward",
        identifierFlag: "--slug",
        rolePrefix: "steward",
        verbName: "launch-steward",
      });
    case "launch-concierge":
      return await handleLaunch({
        argv: process.argv.slice(3),
        requiredSkill: "catalyst-dev:concierge",
        identifierFlag: "--human",
        rolePrefix: "concierge",
        verbName: "launch-concierge",
      });

    // CTL-2095: activity reporting and completion.
    case "activity": {
      if (!arg) die("usage: role-supervisor activity <role> [--in-flight N] [--open-asks N] [--human-newer true|false]");
      const flags = parseFlags(process.argv.slice(4));
      const patch = {};
      if (flags["in-flight"] !== undefined) patch.inFlightTickets = Number(flags["in-flight"]);
      if (flags["open-asks"] !== undefined) patch.openAsksRaised = Number(flags["open-asks"]);
      if (flags["human-newer"] !== undefined) patch.humanCommentNewerThanLastReply = flags["human-newer"] === "true";
      writeActivity(arg, patch);
      console.log(`role-supervisor: activity updated for ${arg}`);
      return 0;
    }
    case "complete": {
      if (!arg) die("usage: role-supervisor complete <role>");
      markComplete(arg);
      console.log(`role-supervisor: ${arg} marked complete — scope_active:false, activity zeroed`);
      return 0;
    }

    default:
      die(
        "usage: role-supervisor run <role> | doctor [--json] | stop <role> | list | " +
          "launch-steward --slug <name> [--scope <str>] [--cwd <dir>] [--dry-run] | " +
          "launch-concierge --human <name> [--scope <str>] [--cwd <dir>] [--dry-run] | " +
          "activity <role> [--in-flight N] [--open-asks N] [--human-newer true|false] | " +
          "complete <role> | " +
          "quiet-fleet [--once] [--dry-run] | holding-sentinel [--once] [--dry-run] | dead-man [--once] [--dry-run]",
      );
  }
}

// ── CTL-2095: launch helpers ─────────────────────────────────────────────────

/** Parse simple --flag value / --bool-flag argv into an object. */
function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dry-run") { flags.dryRun = true; continue; }
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      flags[key] = (i + 1 < argv.length && !argv[i + 1].startsWith("--")) ? argv[++i] : true;
    }
  }
  return flags;
}

/**
 * Validate args and invoke install.sh.
 * Exported so tests can supply a mock `spawnInstall` to capture the call.
 */
export function launchRole({ role, requiredSkill, scope, cwd, dryRun = false }, spawnInstall) {
  const args = ["--role", role, "--skill", requiredSkill];
  if (scope) args.push("--scope", scope);
  if (cwd) args.push("--cwd", cwd);
  if (dryRun) args.push("--dry-run");
  if (spawnInstall) return spawnInstall(args);
  return new Promise((resolve, reject) => {
    const proc = spawn("bash", [INSTALL_SH, ...args], { stdio: "inherit" });
    proc.on("close", (code) => {
      if (code === 0) resolve(0);
      else {
        const err = Object.assign(new Error(`install.sh exited ${code}`), { exitCode: code });
        reject(err);
      }
    });
    proc.on("error", reject);
  });
}

async function handleLaunch({ argv, requiredSkill, identifierFlag, rolePrefix, verbName }) {
  const flags = parseFlags(argv);
  // --brief is never allowed: the skill contract is the brief.
  if (flags.brief) {
    die(`${verbName}: --brief is not allowed — ${rolePrefix}s are launched from the skill contract (${requiredSkill}), not a brief`);
  }
  // --skill override is only valid if it matches the required contract.
  if (flags.skill && flags.skill !== requiredSkill) {
    die(`${verbName}: --skill must be ${requiredSkill} (got '${flags.skill}') — a ${rolePrefix} is launched from the skill contract, never a different skill`);
  }
  const identifier = flags[identifierFlag.slice(2)]; // e.g. "slug" or "human"
  if (!identifier) {
    die(`usage: role-supervisor ${verbName} ${identifierFlag} <name> [--scope <str>] [--cwd <dir>] [--dry-run]`);
  }
  const role = `${rolePrefix}-${identifier}`;
  try {
    await launchRole({ role, requiredSkill, scope: flags.scope, cwd: flags.cwd, dryRun: flags.dryRun });
  } catch (e) {
    die(e.message);
  }
  return 0;
}

// ── Shared instrument loop for quiet-fleet / holding-sentinel / dead-man ─────

// Shared instrument loop for quiet-fleet / holding-sentinel / dead-man.
// `runOnce({dryRun})` returns a JSON-serialisable tick result. Fail-open: a
// throwing tick logs and continues so a launchd-supervised alarm never wedges.
async function runInstrument(name, runOnce) {
  const once = process.argv.includes("--once");
  const dryRun = process.argv.includes("--dry-run");
  const tick = () => {
    const r = runOnce({ dryRun });
    console.log(JSON.stringify(r));
    return r;
  };
  if (once) {
    tick();
    return 0;
  }
  for (;;) {
    try {
      tick();
    } catch (e) {
      console.error(`role-supervisor: ${name} tick error — ${e.message}`);
    }
    await sleep(QUIET_FLEET_INTERVAL_MS);
  }
}

function die(msg) {
  console.error(`role-supervisor: ${msg}`);
  process.exit(2);
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error(`role-supervisor: ${err.message}`);
  process.exit(1);
});
