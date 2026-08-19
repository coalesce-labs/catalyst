#!/usr/bin/env node
// cli.mjs — CTL-1994. `role-supervisor <verb>`.
//
//   run <role>       supervise a role in the foreground (launchd runs this)
//   doctor [--json]  one row per role: liveness, status-doc age, restarts
//   stop <role>      ask a role to write its handoff and exit; it stays down
//   list             the configured roles
//   quiet-fleet [--once] [--dry-run]   page the concierge when a role goes quiet
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { superviseRole } from "./supervisor.mjs";
import { runSdkSession } from "./sdk-session.mjs";
import { report, formatReport, listRoles } from "./doctor.mjs";
import { runQuietFleetOnce } from "./quiet-fleet.mjs";
import { roleFiles } from "./paths.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// One tick a minute, matching the plist's ThrottleInterval — the alarm never
// touches the daemon hot path or Linear/GitHub.
const QUIET_FLEET_INTERVAL_MS = 60_000;

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
    case "quiet-fleet": {
      // The launchd-supervised alarm. `--once` runs a single tick (what the
      // plist's StartInterval fires); with no flags it loops in the foreground.
      // `--dry-run` prints the pages it WOULD send and mutates nothing.
      const once = process.argv.includes("--once");
      const dryRun = process.argv.includes("--dry-run");
      const tick = () => {
        const r = runQuietFleetOnce({ dryRun });
        console.log(JSON.stringify(r));
        return r;
      };
      if (once) {
        tick();
        return 0;
      }
      // Foreground loop. launchd's KeepAlive restarts this if it ever exits.
      for (;;) {
        try {
          tick();
        } catch (e) {
          // Fail-open: a bad tick must not stop the alarm.
          console.error(`role-supervisor: quiet-fleet tick error — ${e.message}`);
        }
        await sleep(QUIET_FLEET_INTERVAL_MS);
      }
    }
    default:
      die("usage: role-supervisor run <role> | doctor [--json] | stop <role> | list | quiet-fleet [--once] [--dry-run]");
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
