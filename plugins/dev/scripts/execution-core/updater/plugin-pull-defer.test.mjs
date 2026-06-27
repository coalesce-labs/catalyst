// plugin-pull-defer.test.mjs — CTL-1348. The load-bearing "updater owns; broker
// DEFERS" safety invariant for refreshPluginCheckout's new `pull` option:
//   - pull omitted (default) preserves today's fetch + reset --hard + bun install.
//   - pull:false (detect-only) NEVER reset --hard / bun install, emits ONLY
//     plugin.checkout.drift, returns changed:false so decideStackReload is a no-op
//     (a behind checkout the broker never pulled must not restart the stack), and
//     does NOT poison the throttle (a later real pull on the same root is not blocked).
//
// Lives under execution-core/ (not broker/) deliberately: the broker test suite
// (broker/*.test.mjs) is wired into NO GitHub workflow, but this cutover safety
// invariant must be CI-gated. It imports the broker functions under test directly
// (exec-core -> broker cross-import precedent: scheduler.mjs imports ../broker/broker-state.mjs).
import { describe, test, expect, beforeEach } from "bun:test";
import {
  refreshPluginCheckout,
  refreshAllPluginCheckouts,
  resolvePluginPullOwner,
  __clearLagStateForTest,
  PLUGIN_DRIFT_GRACE_MS,
} from "../../broker/plugin-refresh.mjs";

// Clear the per-root drift-grace + lag state between tests so first-behind timestamps
// don't leak across cases (the grace tracker is module-level).
beforeEach(() => __clearLagStateForTest());

// Scriptable gitFn: records every `<args>` call and answers rev-parse from a
// sequence (HEAD) + a fixed origin/main; fetch/reset/diff return "".
function makeGit({ headSeq = [], origin = "" } = {}) {
  const calls = [];
  let i = 0;
  const git = (_root, args) => {
    const a = args.join(" ");
    calls.push(a);
    if (a === "rev-parse HEAD") return headSeq[i++] ?? headSeq[headSeq.length - 1] ?? "";
    if (a === "rev-parse origin/main") return origin;
    return ""; // fetch / reset --hard / diff
  };
  git.calls = calls;
  return git;
}
const banBunInstall = () => {
  throw new Error("bunInstallFn must never be called in detect-only mode");
};

describe("refreshPluginCheckout pull option (CTL-1348 cutover)", () => {
  test("pull omitted (default) still does fetch + reset --hard + emits plugin.checkout.updated", () => {
    const git = makeGit({ headSeq: ["oldsha", "newsha"] });
    const events = [];
    const r = refreshPluginCheckout({
      root: "/r/default",
      gitFn: git,
      bunInstallFn: () => {}, // no changed package dirs (diff returns "") so unused, but safe
      emitFn: (e) => events.push(e),
    });
    expect(git.calls).toContain("fetch --no-tags origin main");
    expect(git.calls).toContain("reset --hard origin/main");
    expect(r.pulled).toBe(true);
    expect(r.changed).toBe(true);
    expect(events.map((e) => e.event)).toContain("plugin.checkout.updated");
  });

  test("pull:false (detect-only) when BEHIND past the grace window: emits plugin.checkout.drift, NEVER reset/install, changed:false", () => {
    const git = makeGit({ headSeq: ["headsha", "headsha"], origin: "originsha" });
    const events = [];
    // First detection seeds first-behind; within grace → NO warn.
    refreshPluginCheckout({ root: "/r/behind", now: 0, gitFn: git, bunInstallFn: banBunInstall, emitFn: (e) => events.push(e), pull: false });
    expect(events.find((e) => e.event === "plugin.checkout.drift")).toBeUndefined();
    // Still behind PAST the grace window → the updater missed its SLA → warn now.
    const r = refreshPluginCheckout({ root: "/r/behind", now: PLUGIN_DRIFT_GRACE_MS + 1, gitFn: git, bunInstallFn: banBunInstall, emitFn: (e) => events.push(e), pull: false });
    expect(git.calls).toContain("fetch --no-tags origin main");
    expect(git.calls).not.toContain("reset --hard origin/main"); // the core invariant
    expect(r.pulled).toBe(false);
    expect(r.changed).toBe(false); // so decideStackReload stays a no-op
    expect(r.restartNeeded).toBe(false);
    const drift = events.find((e) => e.event === "plugin.checkout.drift");
    expect(drift).toBeTruthy();
    expect(drift.severity).toBe("WARN");
    expect(drift.detail).toMatchObject({ checkout: "/r/behind", head_sha: "headsha", origin_sha: "originsha", behind: true, behind_since: 0 });
  });

  test("pull:false (detect-only) BEHIND but WITHIN the grace window: stays SILENT (no false drift while the updater catches up)", () => {
    const git = makeGit({ headSeq: ["h", "h"], origin: "o" });
    const events = [];
    refreshPluginCheckout({ root: "/r/grace", now: 1000, gitFn: git, bunInstallFn: banBunInstall, emitFn: (e) => events.push(e), pull: false });
    refreshPluginCheckout({ root: "/r/grace", now: 1000 + PLUGIN_DRIFT_GRACE_MS - 1, gitFn: git, bunInstallFn: banBunInstall, emitFn: (e) => events.push(e), pull: false });
    expect(events.filter((e) => e.event === "plugin.checkout.drift")).toHaveLength(0);
    expect(git.calls).not.toContain("reset --hard origin/main");
  });

  test("pull:false (detect-only) when UP TO DATE: no drift event, no reset, changed:false", () => {
    const git = makeGit({ headSeq: ["samesha"], origin: "samesha" });
    const events = [];
    const r = refreshPluginCheckout({
      root: "/r/uptodate",
      gitFn: git,
      bunInstallFn: banBunInstall,
      emitFn: (e) => events.push(e),
      pull: false,
    });
    expect(git.calls).not.toContain("reset --hard origin/main");
    expect(r.changed).toBe(false);
    expect(events).toEqual([]);
  });

  test("pull:false does NOT poison the throttle — a later real pull on the same root is not blocked", () => {
    const root = "/r/throttle";
    const detectGit = makeGit({ headSeq: ["a"], origin: "b" });
    refreshPluginCheckout({ root, now: 1000, gitFn: detectGit, bunInstallFn: banBunInstall, emitFn: () => {}, pull: false });
    // 1ms later a REAL pull on the same root must proceed (detect-only never reserved the slot).
    const pullGit = makeGit({ headSeq: ["a", "c"] });
    const r = refreshPluginCheckout({ root, now: 1001, gitFn: pullGit, bunInstallFn: () => {}, emitFn: () => {} });
    expect(r.throttled).toBe(false);
    expect(pullGit.calls).toContain("reset --hard origin/main");
  });

  test("a detect-only result cannot trigger a stack restart (changed:false → decideStackReload no-op)", () => {
    const git = makeGit({ headSeq: ["headsha"], origin: "originsha" });
    const r = refreshPluginCheckout({ root: "/r/decide", gitFn: git, bunInstallFn: banBunInstall, emitFn: () => {}, pull: false });
    // decideStackReload (broker/stack-reload.mjs:202) returns shouldReload:false when NO
    // result has changed:true; a detect-only result is changed:false + restartNeeded:false,
    // so the broker can never restart the stack onto code it didn't pull. Asserted via the
    // result properties to keep this CI test free of the pino-heavy stack-reload.mjs import.
    expect(r.changed).toBe(false);
    expect(r.restartNeeded).toBe(false);
  });

  test("refreshAllPluginCheckouts threads pull:false to every root (no reset on any; drift after grace)", () => {
    const git = makeGit({ headSeq: ["h1", "h1"], origin: "o1" });
    const events = [];
    const opts = {
      env: { CATALYST_PLUGIN_DIRS: "/wt/a/plugins/dev" },
      gitToplevelFn: () => "/wt/a",
      gitFn: git,
      emitFn: (e) => events.push(e),
      pull: false,
    };
    refreshAllPluginCheckouts({ ...opts, now: 0 }); // seed first-behind (within grace, silent)
    refreshAllPluginCheckouts({ ...opts, now: PLUGIN_DRIFT_GRACE_MS + 1 }); // past grace → drift
    expect(git.calls).not.toContain("reset --hard origin/main");
    expect(events.some((e) => e.event === "plugin.checkout.drift")).toBe(true);
  });
});

describe("resolvePluginPullOwner (CTL-1348 fail-safe cutover gate)", () => {
  const noFile = () => { throw new Error("ENOENT"); };

  test("default with nothing set is 'broker' (inert-by-absence: merge changes nothing)", () => {
    expect(resolvePluginPullOwner({ env: {}, machineConfigPath: undefined })).toBe("broker");
  });

  test("env CATALYST_PLUGIN_PULL_OWNER=updater → 'updater' (trimmed)", () => {
    expect(resolvePluginPullOwner({ env: { CATALYST_PLUGIN_PULL_OWNER: "updater" } })).toBe("updater");
    expect(resolvePluginPullOwner({ env: { CATALYST_PLUGIN_PULL_OWNER: "  updater " } })).toBe("updater");
  });

  test("any non-'updater' env value → 'broker' (only the exact value defers)", () => {
    for (const v of ["broker", "Updater", "yes", "1", "", "   "]) {
      expect(resolvePluginPullOwner({ env: { CATALYST_PLUGIN_PULL_OWNER: v } })).toBe("broker");
    }
  });

  test("machine config catalyst.orchestration.pluginPullOwner=updater (when env unset)", () => {
    const readFileFn = () => JSON.stringify({ catalyst: { orchestration: { pluginPullOwner: "updater" } } });
    expect(resolvePluginPullOwner({ env: {}, machineConfigPath: "/cfg.json", readFileFn })).toBe("updater");
  });

  test("machine config 'broker' / absent key / malformed → 'broker'", () => {
    const broker = () => JSON.stringify({ catalyst: { orchestration: { pluginPullOwner: "broker" } } });
    const absent = () => JSON.stringify({ catalyst: { host: { name: "mini" } } });
    expect(resolvePluginPullOwner({ env: {}, machineConfigPath: "/cfg.json", readFileFn: broker })).toBe("broker");
    expect(resolvePluginPullOwner({ env: {}, machineConfigPath: "/cfg.json", readFileFn: absent })).toBe("broker");
    expect(resolvePluginPullOwner({ env: {}, machineConfigPath: "/cfg.json", readFileFn: () => "{ not json" })).toBe("broker");
    expect(resolvePluginPullOwner({ env: {}, machineConfigPath: "/cfg.json", readFileFn: noFile })).toBe("broker");
  });

  test("env wins over machine config", () => {
    const cfgUpdater = () => JSON.stringify({ catalyst: { orchestration: { pluginPullOwner: "updater" } } });
    expect(resolvePluginPullOwner({ env: { CATALYST_PLUGIN_PULL_OWNER: "broker" }, machineConfigPath: "/cfg.json", readFileFn: cfgUpdater })).toBe("broker");
  });
});
