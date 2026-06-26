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
import { describe, test, expect } from "bun:test";
import {
  refreshPluginCheckout,
  refreshAllPluginCheckouts,
} from "../../broker/plugin-refresh.mjs";

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

  test("pull:false (detect-only) when BEHIND: fetch + compare, emits plugin.checkout.drift, NEVER reset/install, changed:false", () => {
    const git = makeGit({ headSeq: ["headsha"], origin: "originsha" });
    const events = [];
    const r = refreshPluginCheckout({
      root: "/r/behind",
      gitFn: git,
      bunInstallFn: banBunInstall,
      emitFn: (e) => events.push(e),
      pull: false,
    });
    expect(git.calls).toContain("fetch --no-tags origin main");
    expect(git.calls).not.toContain("reset --hard origin/main"); // the core invariant
    expect(r.pulled).toBe(false);
    expect(r.changed).toBe(false); // so decideStackReload stays a no-op
    expect(r.restartNeeded).toBe(false);
    const drift = events.find((e) => e.event === "plugin.checkout.drift");
    expect(drift).toBeTruthy();
    expect(drift.severity).toBe("WARN");
    expect(drift.detail).toMatchObject({ checkout: "/r/behind", head_sha: "headsha", origin_sha: "originsha", behind: true });
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

  test("refreshAllPluginCheckouts threads pull:false to every root (no reset on any)", () => {
    const git = makeGit({ headSeq: ["h1"], origin: "o1" });
    const events = [];
    refreshAllPluginCheckouts({
      env: { CATALYST_PLUGIN_DIRS: "/wt/a/plugins/dev" },
      gitToplevelFn: () => "/wt/a",
      gitFn: git,
      emitFn: (e) => events.push(e),
      pull: false,
    });
    expect(git.calls).not.toContain("reset --hard origin/main");
    expect(events.some((e) => e.event === "plugin.checkout.drift")).toBe(true);
  });
});
