// install-completeness.mjs — CTL-1918.
//
// checkInstallCompleteness — CTL-1918. Does this node carry the four things a
// FINISHED install leaves behind, or only the things a STARTED one does?
//
// setup-catalyst.sh used to end by PRINTING instructions for steps it could perform,
// so "setup completed successfully" and "this node works" were different states with
// nothing measuring the gap. setup now performs them and records what it could not —
// but that ledger is printed once, at the end of a run nobody re-reads. This is the
// standing answer: the same four outcomes, checkable at any time.
//
// ⛔ ADVISORY — never FAIL. Install shape is an operator repair, and doctor's FAIL
// count gates worker activation; a half-installed node must not be made unable to
// work on the strength of a cosmetic gap. Same posture, and same reason, as
// checkRegistryTeamIdentity.
//
// ⚠️ Every leg is three-valued. "I could not look" (unreadable config, absent
// registry, a platform with no launchd) is reported as UNKNOWN and never folded into
// "absent" — a check that reports a missing step for a file it failed to open is how
// an operator gets sent to repair something that was never broken.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * ⛔ DEFINED HERE, NOT IMPORTED FROM doctor.mjs — doctor.mjs imports THIS module, so an
 * import back would be circular. When this check was extracted from doctor.mjs it kept
 * calling doctor's `layer2Path()` as a default parameter, which crashed
 * `catalyst-doctor` outright with `ReferenceError: layer2Path is not defined` on every
 * host. Kept byte-identical to doctor.mjs's own resolver, including the env override.
 */
function layer2Path() {
  return (
    process.env.CATALYST_LAYER2_CONFIG_FILE ||
    resolve(homedir(), ".config", "catalyst", "config.json")
  );
}

import { STATUS, mkCheck } from "./doctor-status.mjs";

export function checkInstallCompleteness(deps = {}) {
  const {
    env = process.env,
    home = homedir(),
    exists = (p) => existsSync(p),
    readJson = (p) => {
      try {
        return { ok: true, value: JSON.parse(readFileSync(p, "utf8")) };
      } catch {
        return { ok: false, value: null };
      }
    },
    layer2 = layer2Path(),
    registryPath = join(home, "catalyst", "execution-core", "registry.json"),
    platform = process.platform,
  } = deps;

  const legs = [];
  const note = (name, state, detail) => legs.push({ name, state, detail });

  // 1. the catalyst-* CLIs on PATH — what install-cli.sh leaves behind.
  const binDir = env.CATALYST_BIN_DIR || env.CATALYST_CLI_BIN_DIR || join(home, ".catalyst", "bin");
  note("cli", exists(join(binDir, "catalyst-stack")) ? "ok" : "missing", binDir);

  // 2. pluginDirs registered — what setup-plugin-source.sh leaves behind. An
  //    unreadable Layer-2 file is UNKNOWN: the key may well be there.
  const cfg = readJson(layer2);
  if (!cfg.ok) {
    note("plugin-source", "unknown", `Layer-2 config unreadable (${layer2})`);
  } else {
    const pd = cfg.value?.catalyst?.orchestration?.pluginDirs;
    const first = Array.isArray(pd) ? pd[0] : typeof pd === "string" ? pd : null;
    note("plugin-source", first ? "ok" : "missing", first || "no pluginDirs key");
  }

  // 3. the orphan-sweep LaunchAgent — macOS only. On any other platform this is not
  //    "missing", it is not applicable, and saying "missing" would be a false repair.
  if (platform !== "darwin") {
    note("orphan-sweep", "unknown", "not macOS — launchd scheduling is a follow-up (CTL-1030)");
  } else {
    const plist = join(home, "Library", "LaunchAgents", "ai.coalesce.catalyst-orphan-sweep.plist");
    note("orphan-sweep", exists(plist) ? "ok" : "missing", plist);
  }

  // 4. at least one project enrolled — without a registry entry the daemon dispatches
  //    nothing, which looks exactly like a broken one.
  const reg = readJson(registryPath);
  if (!exists(registryPath)) {
    note("registry", "missing", `no registry at ${registryPath}`);
  } else if (!reg.ok) {
    note("registry", "unknown", `registry unreadable (${registryPath})`);
  } else {
    const projects = reg.value?.projects;
    const n = Array.isArray(projects)
      ? projects.length
      : projects && typeof projects === "object"
        ? Object.keys(projects).length
        : 0;
    note("registry", n > 0 ? "ok" : "missing", `${n} project(s) enrolled`);
  }

  const missing = legs.filter((l) => l.state === "missing");
  const unknown = legs.filter((l) => l.state === "unknown");
  const fmt = (ls) => ls.map((l) => `${l.name} (${l.detail})`).join("; ");

  if (missing.length === 0 && unknown.length === 0) {
    return mkCheck(
      "install-completeness",
      STATUS.PASS,
      "install is complete — CLIs on PATH, plugin-source registered, orphan-sweep scheduled, project enrolled"
    );
  }
  if (missing.length === 0) {
    return mkCheck(
      "install-completeness",
      STATUS.INFO,
      `install looks complete, but ${unknown.length} leg(s) could not be measured: ${fmt(unknown)}`
    );
  }
  return mkCheck(
    "install-completeness",
    STATUS.WARN,
    `install is INCOMPLETE — ${missing.length} step(s) never landed: ${fmt(missing)}` +
      (unknown.length ? ` | unmeasured: ${fmt(unknown)}` : "") +
      " — re-run setup-catalyst.sh, or complete them from its deferred-step list (CTL-1918)"
  );
}
