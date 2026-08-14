// Unit tests for plugin-refresh.mjs (CTL-993).
//
// A merge to main should refresh every node's pluginDirs checkout within
// seconds: the broker tails the unified event log, and when a GitHub
// push/merge event for the configured repo@main arrives it runs an ff-only
// pull in the resolved checkout, emits plugin.checkout.updated with the new
// HEAD sha, throttles to at most one pull per N seconds, surfaces pull
// failures (instead of failing silently), and makes daemon skew visible
// (restart_needed) without auto-restarting.
//
// Every OS/git/config/clock interaction is an injected seam so the decision
// core and lifecycle are deterministically testable without real load,
// timers, network, or a real checkout. Mirrors the gc-liveness.mjs /
// autotune.mjs seam-injection convention.
//
// Run: bun test plugins/dev/scripts/broker/plugin-refresh.test.mjs

import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolvePluginCheckoutRoots,
  resolveRepoFullName,
  isThisRepoMergeEvent,
  isDaemonLocalMergeSignal,
  refreshPluginCheckout,
  clearStaleIndexLock,
  refreshAllPluginCheckouts,
  startPluginDriftCheck,
  handlePluginRefreshEvent,
  changedPackageDirs,
  changedLockfiles,
  bunInstallArgv,
  workspaceRootsFor,
  defaultResolvePackageFn,
  workspaceMemberNodeModules,
  PLUGIN_REFRESH_THROTTLE_MS,
  PLUGIN_DRIFT_CHECK_INTERVAL_MS,
  __clearThrottleForTest,
  CHECKOUT_LAG_FAILURE_THRESHOLD,
  __clearLagStateForTest,
} from "./plugin-refresh.mjs";

// ─── resolvePluginCheckoutRoots ──────────────────────────────────────────────
//
// JS mirror of lib/plugin-dirs.sh::resolve_plugin_dirs precedence:
//   1. CATALYST_PLUGIN_DIRS env (colon-separated)
//   2. repo .catalyst/config.json → .catalyst.orchestration.pluginDirs
//   3. machine config → .catalyst.orchestration.pluginDirs
// pluginDirs may be a string or array in either file; each entry points at
// <checkout>/plugins/dev and is mapped to its git toplevel and deduped.

describe("resolvePluginCheckoutRoots", () => {
  test("resolves from CATALYST_PLUGIN_DIRS env (highest precedence)", () => {
    const roots = resolvePluginCheckoutRoots({
      env: { CATALYST_PLUGIN_DIRS: "/co/checkout-a/plugins/dev" },
      machineConfigPath: "/cfg/machine.json",
      repoConfigPath: "/repo/.catalyst/config.json",
      readFileFn: () => '{"catalyst":{"orchestration":{"pluginDirs":"/other/plugins/dev"}}}',
      gitToplevelFn: (pd) => pd.replace(/\/plugins\/dev$/, ""),
    });
    expect(roots).toEqual(["/co/checkout-a"]);
  });

  test("falls back to repo config when env unset", () => {
    const roots = resolvePluginCheckoutRoots({
      env: {},
      machineConfigPath: "/cfg/machine.json",
      repoConfigPath: "/repo/.catalyst/config.json",
      readFileFn: (p) =>
        p === "/repo/.catalyst/config.json"
          ? '{"catalyst":{"orchestration":{"pluginDirs":"/repo-co/plugins/dev"}}}'
          : "{}",
      gitToplevelFn: (pd) => pd.replace(/\/plugins\/dev$/, ""),
    });
    expect(roots).toEqual(["/repo-co"]);
  });

  test("falls back to machine config when env + repo config absent", () => {
    const roots = resolvePluginCheckoutRoots({
      env: {},
      machineConfigPath: "/cfg/machine.json",
      repoConfigPath: "/repo/.catalyst/config.json",
      readFileFn: (p) =>
        p === "/cfg/machine.json"
          ? '{"catalyst":{"orchestration":{"pluginDirs":"/mach-co/plugins/dev"}}}'
          : (() => {
              throw new Error("ENOENT");
            })(),
      gitToplevelFn: (pd) => pd.replace(/\/plugins\/dev$/, ""),
    });
    expect(roots).toEqual(["/mach-co"]);
  });

  test("splits a colon-joined env value and dedupes shared roots", () => {
    const roots = resolvePluginCheckoutRoots({
      env: { CATALYST_PLUGIN_DIRS: "/co/plugins/dev:/co/plugins/pm:/co2/plugins/dev" },
      machineConfigPath: "/cfg/machine.json",
      repoConfigPath: "/repo/.catalyst/config.json",
      readFileFn: () => "{}",
      gitToplevelFn: (pd) => pd.replace(/\/plugins\/(dev|pm)$/, ""),
    });
    expect(roots).toEqual(["/co", "/co2"]);
  });

  test("accepts pluginDirs as a JSON array in config (string-or-array tolerant)", () => {
    const roots = resolvePluginCheckoutRoots({
      env: {},
      machineConfigPath: "/cfg/machine.json",
      repoConfigPath: "/repo/.catalyst/config.json",
      readFileFn: (p) =>
        p === "/cfg/machine.json"
          ? '{"catalyst":{"orchestration":{"pluginDirs":["/a/plugins/dev","/b/plugins/dev"]}}}'
          : "{}",
      gitToplevelFn: (pd) => pd.replace(/\/plugins\/dev$/, ""),
    });
    expect(roots).toEqual(["/a", "/b"]);
  });

  test("returns [] when pluginDirs is unset everywhere", () => {
    const roots = resolvePluginCheckoutRoots({
      env: {},
      machineConfigPath: "/cfg/machine.json",
      repoConfigPath: "/repo/.catalyst/config.json",
      readFileFn: () => "{}",
      gitToplevelFn: (pd) => pd,
    });
    expect(roots).toEqual([]);
  });

  test("drops entries whose git toplevel cannot be resolved", () => {
    const roots = resolvePluginCheckoutRoots({
      env: { CATALYST_PLUGIN_DIRS: "/good/plugins/dev:/bad/plugins/dev" },
      machineConfigPath: "/cfg/machine.json",
      repoConfigPath: "/repo/.catalyst/config.json",
      readFileFn: () => "{}",
      gitToplevelFn: (pd) => (pd.startsWith("/good") ? "/good" : null),
    });
    expect(roots).toEqual(["/good"]);
  });
});

// ─── resolveRepoFullName ─────────────────────────────────────────────────────
//
// Repo identity (the repository whose merges trigger a refresh) is read from
// .catalyst.feedback.githubRepo, with the first .catalyst.monitor.linear.teams
// vcsRepo as a fallback. Repo config takes precedence over machine config.

describe("resolveRepoFullName", () => {
  test("reads feedback.githubRepo from the repo config", () => {
    const name = resolveRepoFullName({
      machineConfigPath: "/cfg/machine.json",
      repoConfigPath: "/repo/.catalyst/config.json",
      readFileFn: (p) =>
        p === "/repo/.catalyst/config.json"
          ? '{"catalyst":{"feedback":{"githubRepo":"coalesce-labs/catalyst"}}}'
          : "{}",
    });
    expect(name).toBe("coalesce-labs/catalyst");
  });

  test("falls back to the first monitor.linear.teams[].vcsRepo", () => {
    const name = resolveRepoFullName({
      machineConfigPath: "/cfg/machine.json",
      repoConfigPath: "/repo/.catalyst/config.json",
      readFileFn: (p) =>
        p === "/repo/.catalyst/config.json"
          ? '{"catalyst":{"monitor":{"linear":{"teams":[{"key":"CTL","vcsRepo":"coalesce-labs/catalyst"}]}}}}'
          : "{}",
    });
    expect(name).toBe("coalesce-labs/catalyst");
  });

  test("returns null when no repo identity is configured anywhere", () => {
    const name = resolveRepoFullName({
      machineConfigPath: "/cfg/machine.json",
      repoConfigPath: "/repo/.catalyst/config.json",
      readFileFn: () => "{}",
    });
    expect(name).toBeNull();
  });

  // ── canonical catalyst.repository.{org,name} (CTL-1014) ────────────────────
  //
  // check-project-setup tells operators to set the canonical schema key
  // catalyst.repository.{org,name}. The resolver MUST read it (joined as
  // "org/name") — and prefer it over the legacy feedback.githubRepo /
  // monitor.linear.teams[].vcsRepo keys — or repo identity resolves null on a
  // canonically-configured host and isThisRepoMergeEvent rejects every merge,
  // so the CTL-993 merge-to-main auto-pull never fires (verified live on mini).

  test("reads canonical catalyst.repository.{org,name} joined as org/name", () => {
    const name = resolveRepoFullName({
      machineConfigPath: "/cfg/machine.json",
      repoConfigPath: "/repo/.catalyst/config.json",
      readFileFn: (p) =>
        p === "/repo/.catalyst/config.json"
          ? '{"catalyst":{"repository":{"org":"coalesce-labs","name":"catalyst"}}}'
          : "{}",
    });
    expect(name).toBe("coalesce-labs/catalyst");
  });

  test("canonical catalyst.repository WINS over legacy feedback.githubRepo when both set", () => {
    const name = resolveRepoFullName({
      machineConfigPath: "/cfg/machine.json",
      repoConfigPath: "/repo/.catalyst/config.json",
      readFileFn: (p) =>
        p === "/repo/.catalyst/config.json"
          ? '{"catalyst":{"repository":{"org":"coalesce-labs","name":"catalyst"},"feedback":{"githubRepo":"legacy-org/legacy-repo"}}}'
          : "{}",
    });
    expect(name).toBe("coalesce-labs/catalyst");
  });

  test("malformed canonical repository (missing name) falls through to legacy keys", () => {
    const name = resolveRepoFullName({
      machineConfigPath: "/cfg/machine.json",
      repoConfigPath: "/repo/.catalyst/config.json",
      readFileFn: (p) =>
        p === "/repo/.catalyst/config.json"
          ? '{"catalyst":{"repository":{"org":"coalesce-labs"},"feedback":{"githubRepo":"coalesce-labs/catalyst"}}}'
          : "{}",
    });
    expect(name).toBe("coalesce-labs/catalyst");
  });

  test("malformed canonical repository (empty org) falls through to legacy keys", () => {
    const name = resolveRepoFullName({
      machineConfigPath: "/cfg/machine.json",
      repoConfigPath: "/repo/.catalyst/config.json",
      readFileFn: (p) =>
        p === "/repo/.catalyst/config.json"
          ? '{"catalyst":{"repository":{"org":"","name":"catalyst"},"feedback":{"githubRepo":"coalesce-labs/catalyst"}}}'
          : "{}",
    });
    expect(name).toBe("coalesce-labs/catalyst");
  });

  test("malformed canonical repository (non-string org) falls through to legacy keys", () => {
    const name = resolveRepoFullName({
      machineConfigPath: "/cfg/machine.json",
      repoConfigPath: "/repo/.catalyst/config.json",
      readFileFn: (p) =>
        p === "/repo/.catalyst/config.json"
          ? '{"catalyst":{"repository":{"org":42,"name":"catalyst"},"feedback":{"githubRepo":"coalesce-labs/catalyst"}}}'
          : "{}",
    });
    expect(name).toBe("coalesce-labs/catalyst");
  });

  test("returns null when canonical is malformed AND no legacy key is set", () => {
    const name = resolveRepoFullName({
      machineConfigPath: "/cfg/machine.json",
      repoConfigPath: "/repo/.catalyst/config.json",
      readFileFn: (p) =>
        p === "/repo/.catalyst/config.json"
          ? '{"catalyst":{"repository":{"org":"coalesce-labs"}}}'
          : "{}",
    });
    expect(name).toBeNull();
  });
});

// ─── isThisRepoMergeEvent ────────────────────────────────────────────────────

describe("isThisRepoMergeEvent", () => {
  const repoFullName = "coalesce-labs/catalyst";

  test("true for canonical github.pr.merged on the configured repo", () => {
    const event = {
      attributes: {
        "event.name": "github.pr.merged",
        "vcs.repository.name": "coalesce-labs/catalyst",
      },
      body: { payload: { merged: true } },
    };
    expect(isThisRepoMergeEvent(event, { repoFullName })).toBe(true);
  });

  test("true for canonical github.push to refs/heads/main on the configured repo", () => {
    const event = {
      attributes: {
        "event.name": "github.push",
        "vcs.repository.name": "coalesce-labs/catalyst",
        "vcs.ref.name": "main",
      },
      body: { payload: {} },
    };
    expect(isThisRepoMergeEvent(event, { repoFullName })).toBe(true);
  });

  test("true for legacy flat github.pr.merged shape on the configured repo", () => {
    const event = {
      event: "github.pr.merged",
      scope: { repo: "coalesce-labs/catalyst" },
      detail: { merged: true },
    };
    expect(isThisRepoMergeEvent(event, { repoFullName })).toBe(true);
  });

  test("false for a github.push to a non-main branch", () => {
    const event = {
      attributes: {
        "event.name": "github.push",
        "vcs.repository.name": "coalesce-labs/catalyst",
        "vcs.ref.name": "feat/x",
      },
      body: { payload: {} },
    };
    expect(isThisRepoMergeEvent(event, { repoFullName })).toBe(false);
  });

  test("false for a merge event on a DIFFERENT repo", () => {
    const event = {
      attributes: {
        "event.name": "github.pr.merged",
        "vcs.repository.name": "coalesce-labs/adva",
      },
      body: { payload: { merged: true } },
    };
    expect(isThisRepoMergeEvent(event, { repoFullName })).toBe(false);
  });

  test("false for unrelated event names", () => {
    const event = {
      attributes: {
        "event.name": "github.check_suite.completed",
        "vcs.repository.name": "coalesce-labs/catalyst",
      },
      body: { payload: {} },
    };
    expect(isThisRepoMergeEvent(event, { repoFullName })).toBe(false);
  });

  test("false when repoFullName is not configured (no identity to match)", () => {
    const event = {
      attributes: {
        "event.name": "github.pr.merged",
        "vcs.repository.name": "coalesce-labs/catalyst",
      },
      body: { payload: { merged: true } },
    };
    expect(isThisRepoMergeEvent(event, { repoFullName: null })).toBe(false);
  });
});

// ─── refreshPluginCheckout ───────────────────────────────────────────────────

// makeGitFn — module-level so it can be shared across describe blocks.
function makeGitFn({ before = "aaaa", after = "bbbb", fetchThrows = false } = {}) {
    const calls = [];
    const gitFn = (root, args) => {
      calls.push({ root, args });
      const sub = args[0];
      if (sub === "rev-parse") {
        // first rev-parse → before, subsequent → after (reset advanced HEAD)
        const seen = calls.filter((c) => c.args[0] === "rev-parse").length;
        return seen === 1 ? before : after;
      }
      if (sub === "fetch") {
        if (fetchThrows) {
          const e = new Error("Connection refused");
          throw e;
        }
        return "";
      }
      if (sub === "reset") {
        return "";
      }
      return "";
    };
    gitFn.calls = calls;
    return gitFn;
}

describe("refreshPluginCheckout", () => {
  beforeEach(() => __clearThrottleForTest());

  test("runs fetch + reset --hard and emits plugin.checkout.updated with old+new sha", () => {
    const emitted = [];
    const gitFn = makeGitFn({ before: "old111", after: "new222" });
    const res = refreshPluginCheckout({
      root: "/co",
      now: 1_000_000,
      gitFn,
      emitFn: (e) => emitted.push(e),
    });

    expect(res.pulled).toBe(true);
    const fetchCall = gitFn.calls.find((c) => c.args[0] === "fetch");
    expect(fetchCall.root).toBe("/co");
    expect(fetchCall.args).toEqual(expect.arrayContaining(["fetch", "--no-tags", "origin", "main"]));
    const resetCall = gitFn.calls.find((c) => c.args[0] === "reset");
    expect(resetCall.args).toEqual(expect.arrayContaining(["reset", "--hard", "origin/main"]));
    // no `pull` subcommand is ever issued
    expect(gitFn.calls.some((c) => c.args[0] === "pull")).toBe(false);

    expect(emitted).toHaveLength(1);
    expect(emitted[0].event).toBe("plugin.checkout.updated");
    expect(emitted[0].detail.checkout).toBe("/co");
    expect(emitted[0].detail.old_sha).toBe("old111");
    expect(emitted[0].detail.new_sha).toBe("new222");
  });

  test("dirty working tree no longer fails — reset --hard advances HEAD and emits updated", () => {
    // CTL-1106 regression: git pull --ff-only threw on a dirty tree, causing a
    // refresh_failed event and silent no-reload. fetch + reset --hard is immune
    // to working-tree dirt; the fake simply returns success.
    const emitted = [];
    const gitFn = makeGitFn({ before: "dirty-old", after: "clean-new" });
    const res = refreshPluginCheckout({
      root: "/co",
      now: 0,
      gitFn,
      emitFn: (e) => emitted.push(e),
    });
    expect(res.failed).toBe(false);
    expect(res.changed).toBe(true);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].event).toBe("plugin.checkout.updated");
  });

  test("throttles to at most one pull per N seconds for the same root", () => {
    const emitted = [];
    const gitFn = makeGitFn();
    const args = { root: "/co", gitFn, emitFn: (e) => emitted.push(e) };

    const first = refreshPluginCheckout({ ...args, now: 0 });
    expect(first.pulled).toBe(true);

    // within the throttle window → skipped, no second pull
    const second = refreshPluginCheckout({ ...args, now: PLUGIN_REFRESH_THROTTLE_MS - 1 });
    expect(second.pulled).toBe(false);
    expect(second.throttled).toBe(true);

    // after the window elapses → pull again
    const third = refreshPluginCheckout({ ...args, now: PLUGIN_REFRESH_THROTTLE_MS + 1 });
    expect(third.pulled).toBe(true);

    const fetchCalls = gitFn.calls.filter((c) => c.args[0] === "fetch");
    expect(fetchCalls).toHaveLength(2);
  });

  test("throttle is per-root — a different checkout is not blocked", () => {
    const emitted = [];
    const gitFnA = makeGitFn();
    const gitFnB = makeGitFn();
    const a = refreshPluginCheckout({ root: "/a", now: 0, gitFn: gitFnA, emitFn: (e) => emitted.push(e) });
    const b = refreshPluginCheckout({ root: "/b", now: 0, gitFn: gitFnB, emitFn: (e) => emitted.push(e) });
    expect(a.pulled).toBe(true);
    expect(b.pulled).toBe(true);
  });

  test("genuine fetch failure (network/auth) surfaces refresh_failed (not silent)", () => {
    const emitted = [];
    const gitFn = makeGitFn({ fetchThrows: true });
    const res = refreshPluginCheckout({
      root: "/co",
      now: 0,
      gitFn,
      emitFn: (e) => emitted.push(e),
    });
    expect(res.pulled).toBe(false);
    expect(res.failed).toBe(true);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].event).toBe("plugin.checkout.refresh_failed");
    expect(emitted[0].detail.checkout).toBe("/co");
    expect(typeof emitted[0].detail.error).toBe("string");
    expect(emitted[0].severity).toBe("WARN");
  });

  test("no-op (no event) when HEAD did not advance", () => {
    const emitted = [];
    const gitFn = makeGitFn({ before: "same", after: "same" });
    const res = refreshPluginCheckout({
      root: "/co",
      now: 0,
      gitFn,
      emitFn: (e) => emitted.push(e),
    });
    expect(res.pulled).toBe(true);
    expect(res.changed).toBe(false);
    expect(emitted).toHaveLength(0);
  });

  test("surfaces daemon skew: restart_needed flag on the updated event", () => {
    const emitted = [];
    const gitFn = makeGitFn({ before: "boot00", after: "fresh1" });
    refreshPluginCheckout({
      root: "/co",
      now: 0,
      gitFn,
      emitFn: (e) => emitted.push(e),
      // the daemon booted at boot00; the checkout just advanced past it
      loadedCommit: "boot00",
    });
    expect(emitted[0].event).toBe("plugin.checkout.updated");
    expect(emitted[0].detail.restart_needed).toBe(true);
    expect(emitted[0].detail.loaded_commit).toBe("boot00");
  });

  test("restart_needed is false when the daemon's loaded commit is unknown", () => {
    const emitted = [];
    const gitFn = makeGitFn({ before: "a", after: "b" });
    refreshPluginCheckout({
      root: "/co",
      now: 0,
      gitFn,
      emitFn: (e) => emitted.push(e),
    });
    expect(emitted[0].detail.restart_needed).toBe(false);
  });

  test("restart_needed only fires for the daemon's OWN checkout (loadedCommitRoot)", () => {
    // The broker runs from checkout /broker-co; an unrelated pluginDirs
    // checkout /co advancing must NOT flag the broker as stale.
    const emittedOther = [];
    refreshPluginCheckout({
      root: "/co",
      now: 0,
      gitFn: makeGitFn({ before: "boot00", after: "fresh1" }),
      emitFn: (e) => emittedOther.push(e),
      loadedCommit: "boot00",
      loadedCommitRoot: "/broker-co",
    });
    expect(emittedOther[0].event).toBe("plugin.checkout.updated");
    expect(emittedOther[0].detail.restart_needed).toBe(false);

    // Same checkout → skew DOES flag.
    const emittedOwn = [];
    refreshPluginCheckout({
      root: "/broker-co",
      now: 0,
      gitFn: makeGitFn({ before: "boot00", after: "fresh1" }),
      emitFn: (e) => emittedOwn.push(e),
      loadedCommit: "boot00",
      loadedCommitRoot: "/broker-co",
    });
    expect(emittedOwn[0].detail.restart_needed).toBe(true);
  });
});

// ─── handlePluginRefreshEvent (orchestration) ────────────────────────────────

describe("handlePluginRefreshEvent", () => {
  let tmpDir;
  let machineConfigPath;

  beforeEach(() => {
    __clearThrottleForTest();
    tmpDir = mkdtempSync(join(tmpdir(), "plugin-refresh-test-"));
    machineConfigPath = join(tmpDir, "machine.json");
    mkdirSync(join(tmpDir, "co"), { recursive: true });
    writeFileSync(
      machineConfigPath,
      JSON.stringify({
        catalyst: { orchestration: { pluginDirs: join(tmpDir, "co", "plugins", "dev") } },
      })
    );
  });

  test("pulls + emits on a merge event for the configured repo", () => {
    const emitted = [];
    let pulled = false;
    handlePluginRefreshEvent({
      event: {
        attributes: {
          "event.name": "github.pr.merged",
          "vcs.repository.name": "coalesce-labs/catalyst",
        },
        body: { payload: { merged: true } },
      },
      now: 0,
      env: {},
      repoFullName: "coalesce-labs/catalyst",
      machineConfigPath,
      repoConfigPath: join(tmpDir, "nope", ".catalyst", "config.json"),
      gitToplevelFn: (pd) => pd.replace(/\/plugins\/dev$/, ""),
      gitFn: (root, args) => {
        if (args[0] === "fetch") {
          pulled = true;
          return "";
        }
        if (args[0] === "reset") return "";
        if (args[0] === "rev-parse") return pulled ? "new" : "old";
        return "";
      },
      emitFn: (e) => emitted.push(e),
    });
    expect(pulled).toBe(true);
    expect(emitted.some((e) => e.event === "plugin.checkout.updated")).toBe(true);
  });

  test("ignores events that are not a merge to the configured repo", () => {
    const emitted = [];
    let pulled = false;
    handlePluginRefreshEvent({
      event: {
        attributes: {
          "event.name": "github.pr.merged",
          "vcs.repository.name": "coalesce-labs/adva",
        },
        body: { payload: { merged: true } },
      },
      now: 0,
      env: {},
      repoFullName: "coalesce-labs/catalyst",
      machineConfigPath,
      repoConfigPath: join(tmpDir, "nope", ".catalyst", "config.json"),
      gitToplevelFn: (pd) => pd.replace(/\/plugins\/dev$/, ""),
      gitFn: () => {
        pulled = true;
        return "";
      },
      emitFn: (e) => emitted.push(e),
    });
    expect(pulled).toBe(false);
    expect(emitted).toHaveLength(0);
  });

  test("is a no-op (no throw) when no pluginDirs are configured", () => {
    writeFileSync(machineConfigPath, "{}");
    const emitted = [];
    expect(() =>
      handlePluginRefreshEvent({
        event: {
          attributes: {
            "event.name": "github.pr.merged",
            "vcs.repository.name": "coalesce-labs/catalyst",
          },
          body: { payload: { merged: true } },
        },
        now: 0,
        env: {},
        repoFullName: "coalesce-labs/catalyst",
        machineConfigPath,
        repoConfigPath: join(tmpDir, "nope", ".catalyst", "config.json"),
        gitToplevelFn: (pd) => pd,
        gitFn: () => "",
        emitFn: (e) => emitted.push(e),
      })
    ).not.toThrow();
    expect(emitted).toHaveLength(0);
  });
});

// ─── CTL-1077 regression-guard: enriched result shape ───────────────────────
// refreshPluginCheckout must return root/oldSha/newSha/restartNeeded so the
// new stack-reload module can drive the reload decision without a second git
// call. Existing CTL-993 emit assertions must still pass unchanged.

describe("refreshPluginCheckout — enriched result shape (CTL-1077)", () => {
  beforeEach(() => __clearThrottleForTest());

  test("changed pull returns root/oldSha/newSha/restartNeeded", () => {
    let head = "old";
    const res = refreshPluginCheckout({
      root: "/co",
      now: 1,
      gitFn: (root, args) => {
        if (args[0] === "rev-parse") return head;
        if (args[0] === "fetch") return "";
        if (args[0] === "reset") { head = "new"; return ""; }
        return "";
      },
      emitFn: () => {},
      loadedCommit: "old",
      loadedCommitRoot: "/co",
    });
    expect(res).toMatchObject({
      root: "/co", oldSha: "old", newSha: "new", changed: true, restartNeeded: true,
    });
  });

  test("throttled pull returns root with null shas", () => {
    // prime the throttle
    refreshPluginCheckout({ root: "/co", now: 0, gitFn: () => "sha", emitFn: () => {} });
    const res = refreshPluginCheckout({ root: "/co", now: 1, gitFn: () => "sha", emitFn: () => {} });
    expect(res.throttled).toBe(true);
    expect(res.root).toBe("/co");
    expect(res.oldSha).toBeNull();
    expect(res.newSha).toBeNull();
  });

  test("pull failure returns root with oldSha and null newSha", () => {
    const res = refreshPluginCheckout({
      root: "/co",
      now: 1,
      gitFn: (root, args) => {
        if (args[0] === "rev-parse") return "oldsha";
        throw new Error("not fast-forwardable");
      },
      emitFn: () => {},
    });
    expect(res.failed).toBe(true);
    expect(res.root).toBe("/co");
    expect(res.oldSha).toBe("oldsha");
    expect(res.newSha).toBeNull();
  });

  test("no-change pull returns root/oldSha/newSha with changed false", () => {
    const res = refreshPluginCheckout({
      root: "/co",
      now: 1,
      gitFn: () => "sameSha",
      emitFn: () => {},
    });
    expect(res.changed).toBe(false);
    expect(res.root).toBe("/co");
    expect(res.oldSha).toBe("sameSha");
    expect(res.newSha).toBe("sameSha");
  });
});

describe("handlePluginRefreshEvent — returns per-root results array (CTL-1077)", () => {
  beforeEach(() => __clearThrottleForTest());

  test("returns an array of per-root results on a merge event", () => {
    let pulled = false;
    const results = handlePluginRefreshEvent({
      event: {
        attributes: {
          "event.name": "github.pr.merged",
          "vcs.repository.name": "coalesce-labs/catalyst",
        },
        body: { payload: { merged: true } },
      },
      now: 0,
      env: {},
      repoFullName: "coalesce-labs/catalyst",
      machineConfigPath: "/no/machine.json",
      repoConfigPath: "/no/repo.json",
      readFileFn: (p) => {
        if (p === "/no/machine.json")
          return JSON.stringify({ catalyst: { orchestration: { pluginDirs: "/co/plugins/dev" } } });
        throw new Error("ENOENT");
      },
      gitToplevelFn: (pd) => pd.replace(/\/plugins\/dev$/, ""),
      gitFn: (root, args) => {
        if (args[0] === "fetch") { pulled = true; return ""; }
        if (args[0] === "reset") return "";
        if (args[0] === "rev-parse") return pulled ? "new" : "old";
        return "";
      },
      emitFn: () => {},
    });
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBe(1);
    expect(results[0]).toMatchObject({ root: "/co", changed: true });
  });

  test("returns null for non-merge events (existing CTL-993 behavior preserved)", () => {
    const results = handlePluginRefreshEvent({
      event: { attributes: { "event.name": "linear.issue.created" }, body: {} },
      now: 0,
      env: {},
      repoFullName: "coalesce-labs/catalyst",
      machineConfigPath: "/no/machine.json",
      repoConfigPath: "/no/repo.json",
      readFileFn: () => "{}",
      gitToplevelFn: (pd) => pd,
      gitFn: () => "",
      emitFn: () => {},
    });
    expect(results).toBeNull();
  });
});

// ─── checkout-lag alarm (CTL-1106 Phase 2) ──────────────────────────────────
//
// When genuine refresh failures (network/auth) persist across more than one
// merge cycle, emit a one-shot `plugin.checkout.lag` event so Fleet Ops /
// health surfaces the stall instead of silence. Reset on recovery.

describe("checkout-lag alarm", () => {
  beforeEach(() => {
    __clearThrottleForTest();
    __clearLagStateForTest();
  });

  // Helper: advance `now` past the throttle window to allow each call to execute.
  function advanceNow(base, step) {
    return base + step * (PLUGIN_REFRESH_THROTTLE_MS + 1);
  }

  test("a single failure does not emit plugin.checkout.lag", () => {
    const emitted = [];
    refreshPluginCheckout({
      root: "/co",
      now: advanceNow(0, 0),
      gitFn: makeGitFn({ fetchThrows: true }),
      emitFn: (e) => emitted.push(e),
    });
    expect(emitted.some((e) => e.event === "plugin.checkout.lag")).toBe(false);
    expect(emitted.some((e) => e.event === "plugin.checkout.refresh_failed")).toBe(true);
  });

  test("N consecutive failures emit exactly one plugin.checkout.lag", () => {
    const emitted = [];
    for (let i = 0; i < CHECKOUT_LAG_FAILURE_THRESHOLD; i++) {
      refreshPluginCheckout({
        root: "/co",
        now: advanceNow(0, i),
        gitFn: makeGitFn({ fetchThrows: true }),
        emitFn: (e) => emitted.push(e),
      });
    }
    const lagEvents = emitted.filter((e) => e.event === "plugin.checkout.lag");
    expect(lagEvents).toHaveLength(1);
    expect(lagEvents[0].detail.checkout).toBe("/co");
    expect(lagEvents[0].detail.consecutive_failures).toBeGreaterThanOrEqual(CHECKOUT_LAG_FAILURE_THRESHOLD);
    expect(typeof lagEvents[0].detail.behind_since).toBe("number");
    expect(lagEvents[0].severity).toBe("ERROR");
  });

  test("lag is one-shot — further failures after emit do not re-emit", () => {
    const emitted = [];
    for (let i = 0; i < CHECKOUT_LAG_FAILURE_THRESHOLD + 3; i++) {
      refreshPluginCheckout({
        root: "/co",
        now: advanceNow(0, i),
        gitFn: makeGitFn({ fetchThrows: true }),
        emitFn: (e) => emitted.push(e),
      });
    }
    const lagEvents = emitted.filter((e) => e.event === "plugin.checkout.lag");
    expect(lagEvents).toHaveLength(1);
  });

  test("a success resets the failure counter — lag not emitted until threshold reached anew", () => {
    const emitted = [];
    // Fail threshold-1 times
    for (let i = 0; i < CHECKOUT_LAG_FAILURE_THRESHOLD - 1; i++) {
      refreshPluginCheckout({
        root: "/co",
        now: advanceNow(0, i),
        gitFn: makeGitFn({ fetchThrows: true }),
        emitFn: (e) => emitted.push(e),
      });
    }
    // One success — advances HEAD, resets counter
    refreshPluginCheckout({
      root: "/co",
      now: advanceNow(0, CHECKOUT_LAG_FAILURE_THRESHOLD - 1),
      gitFn: makeGitFn({ before: "a", after: "b" }),
      emitFn: (e) => emitted.push(e),
    });
    // Fail threshold-1 more times — should NOT emit lag (counter was reset)
    for (let i = 0; i < CHECKOUT_LAG_FAILURE_THRESHOLD - 1; i++) {
      refreshPluginCheckout({
        root: "/co",
        now: advanceNow(0, CHECKOUT_LAG_FAILURE_THRESHOLD + i),
        gitFn: makeGitFn({ fetchThrows: true }),
        emitFn: (e) => emitted.push(e),
      });
    }
    expect(emitted.some((e) => e.event === "plugin.checkout.lag")).toBe(false);
  });

  test("lag counter is per-root — failures on /a do not push /b toward its threshold", () => {
    const emitted = [];
    for (let i = 0; i < CHECKOUT_LAG_FAILURE_THRESHOLD; i++) {
      refreshPluginCheckout({
        root: "/a",
        now: advanceNow(0, i),
        gitFn: makeGitFn({ fetchThrows: true }),
        emitFn: (e) => emitted.push(e),
      });
    }
    // /b has had zero failures — should emit nothing
    const lagForB = emitted.filter(
      (e) => e.event === "plugin.checkout.lag" && e.detail.checkout === "/b"
    );
    expect(lagForB).toHaveLength(0);
    // /a should have one lag event
    const lagForA = emitted.filter(
      (e) => e.event === "plugin.checkout.lag" && e.detail.checkout === "/a"
    );
    expect(lagForA).toHaveLength(1);
  });
});

// ─── self-filter loop guard (CTL-346 / CTL-993) ──────────────────────────────
// The events this module emits must be dropped by shouldSkipEvent on re-ingest
// so the broker never wakes itself on its own plugin.checkout.* output.

describe("emitted events cannot loop through shouldSkipEvent", () => {
  test("plugin.checkout.updated / refresh_failed wrapped in a broker envelope are skipped", async () => {
    const { buildCanonicalEnvelope, shouldSkipEvent } = await import("./router.mjs");
    for (const name of ["plugin.checkout.updated", "plugin.checkout.refresh_failed"]) {
      const canonical = buildCanonicalEnvelope({ event: name, detail: {} });
      // buildCanonicalEnvelope stamps resource["service.name"] = catalyst.broker,
      // which shouldSkipEvent drops on re-ingest.
      expect(canonical.resource["service.name"]).toBe("catalyst.broker");
      expect(shouldSkipEvent(canonical)).toBe(true);
    }
  });
});

// ─── isDaemonLocalMergeSignal (CTL-1161 Phase 1) ─────────────────────────────
//
// Daemon-local merge signal: phase.monitor-merge.complete.<TICKET> is emitted
// by every pipeline merge into THIS daemon's event log, independently of GitHub
// webhook delivery. Match on event name only (no repo attribute to check).

describe("isDaemonLocalMergeSignal", () => {
  test("true for phase.monitor-merge.complete.CTL-1161", () => {
    expect(isDaemonLocalMergeSignal({ attributes: { "event.name": "phase.monitor-merge.complete.CTL-1161" } })).toBe(true);
  });

  test("true for any ticket suffix shape (ABC-9)", () => {
    expect(isDaemonLocalMergeSignal({ attributes: { "event.name": "phase.monitor-merge.complete.ABC-9" } })).toBe(true);
  });

  test("true for legacy flat event shape", () => {
    expect(isDaemonLocalMergeSignal({ event: "phase.monitor-merge.complete.CTL-42" })).toBe(true);
  });

  test("false for phase.monitor-merge.failed (not complete)", () => {
    expect(isDaemonLocalMergeSignal({ attributes: { "event.name": "phase.monitor-merge.failed.CTL-1161" } })).toBe(false);
  });

  test("false for an unrelated phase event (phase.research.complete.CTL-1161)", () => {
    expect(isDaemonLocalMergeSignal({ attributes: { "event.name": "phase.research.complete.CTL-1161" } })).toBe(false);
  });

  test("false for github.push (that is isThisRepoMergeEvent's job)", () => {
    expect(isDaemonLocalMergeSignal({ attributes: { "event.name": "github.push", "vcs.ref.name": "main" } })).toBe(false);
  });

  test("false for github.pr.merged", () => {
    expect(isDaemonLocalMergeSignal({ attributes: { "event.name": "github.pr.merged" } })).toBe(false);
  });
});

// ─── handlePluginRefreshEvent — daemon-local merge signal (CTL-1161 Phase 1) ─

describe("handlePluginRefreshEvent — daemon-local merge trigger (CTL-1161)", () => {
  beforeEach(() => __clearThrottleForTest());

  const baseArgs = {
    now: 0,
    env: {},
    repoFullName: "coalesce-labs/catalyst",
    machineConfigPath: "/no/machine.json",
    repoConfigPath: "/no/repo.json",
    readFileFn: (p) => {
      if (p === "/no/machine.json")
        return JSON.stringify({ catalyst: { orchestration: { pluginDirs: "/co/plugins/dev" } } });
      throw new Error("ENOENT");
    },
    gitToplevelFn: (pd) => pd.replace(/\/plugins\/dev$/, ""),
  };

  test("fires a pull for phase.monitor-merge.complete.CTL-1161 with no vcs.repository.name", () => {
    const emitted = [];
    let fetched = false;
    const results = handlePluginRefreshEvent({
      ...baseArgs,
      event: { attributes: { "event.name": "phase.monitor-merge.complete.CTL-1161" } },
      gitFn: (root, args) => {
        if (args[0] === "fetch") { fetched = true; return ""; }
        if (args[0] === "reset") return "";
        if (args[0] === "rev-parse") return fetched ? "new" : "old";
        return "";
      },
      emitFn: (e) => emitted.push(e),
    });
    expect(fetched).toBe(true);
    expect(Array.isArray(results)).toBe(true);
    expect(emitted.some((e) => e.event === "plugin.checkout.updated")).toBe(true);
  });

  test("second phase.monitor-merge.complete within throttle window is throttled (no double-pull)", () => {
    const emitted = [];
    let fetchCount = 0;
    const gitFn = (root, args) => {
      if (args[0] === "fetch") { fetchCount++; return ""; }
      if (args[0] === "reset") return "";
      if (args[0] === "rev-parse") return fetchCount > 0 ? "new" : "old";
      return "";
    };
    const phaseEvent = { attributes: { "event.name": "phase.monitor-merge.complete.CTL-1161" } };

    handlePluginRefreshEvent({ ...baseArgs, now: 0, event: phaseEvent, gitFn, emitFn: (e) => emitted.push(e) });
    const r2 = handlePluginRefreshEvent({ ...baseArgs, now: PLUGIN_REFRESH_THROTTLE_MS - 1, event: phaseEvent, gitFn, emitFn: (e) => emitted.push(e) });

    expect(fetchCount).toBe(1);
    expect(r2[0].throttled).toBe(true);
  });

  test("is still null (no-op) for a non-merge, non-phase event (regression guard)", () => {
    const results = handlePluginRefreshEvent({
      ...baseArgs,
      event: { attributes: { "event.name": "linear.issue.created" } },
      gitFn: () => "",
      emitFn: () => {},
    });
    expect(results).toBeNull();
  });
});

// ─── refreshAllPluginCheckouts (CTL-1161 Phase 2) ────────────────────────────
//
// Timer-driven analogue of handlePluginRefreshEvent's body without the event
// gate. Resolves roots via resolvePluginCheckoutRoots and calls
// refreshPluginCheckout per root.

describe("refreshAllPluginCheckouts", () => {
  beforeEach(() => __clearThrottleForTest());

  test("calls refreshPluginCheckout once per resolved root (1-root config)", () => {
    let fetched = false;
    const results = refreshAllPluginCheckouts({
      now: 0,
      env: {},
      machineConfigPath: "/no/machine.json",
      repoConfigPath: "/no/repo.json",
      readFileFn: (p) => {
        if (p === "/no/machine.json")
          return JSON.stringify({ catalyst: { orchestration: { pluginDirs: "/co/plugins/dev" } } });
        throw new Error("ENOENT");
      },
      gitToplevelFn: (pd) => pd.replace(/\/plugins\/dev$/, ""),
      gitFn: (root, args) => {
        if (args[0] === "fetch") { fetched = true; return ""; }
        if (args[0] === "reset") return "";
        if (args[0] === "rev-parse") return fetched ? "new" : "old";
        return "";
      },
      emitFn: () => {},
    });
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBe(1);
    expect(results[0].root).toBe("/co");
    expect(fetched).toBe(true);
  });

  test("calls refreshPluginCheckout for each root in a 2-root config", () => {
    const fetched = new Set();
    const results = refreshAllPluginCheckouts({
      now: 0,
      env: { CATALYST_PLUGIN_DIRS: "/co-a/plugins/dev:/co-b/plugins/dev" },
      machineConfigPath: "/no/machine.json",
      repoConfigPath: "/no/repo.json",
      readFileFn: () => "{}",
      gitToplevelFn: (pd) => pd.replace(/\/plugins\/dev$/, ""),
      gitFn: (root, args) => {
        if (args[0] === "fetch") { fetched.add(root); return ""; }
        if (args[0] === "reset") return "";
        if (args[0] === "rev-parse") return fetched.has(root) ? "new" : "old";
        return "";
      },
      emitFn: () => {},
    });
    expect(results.length).toBe(2);
    expect(fetched.has("/co-a")).toBe(true);
    expect(fetched.has("/co-b")).toBe(true);
  });

  test("returns [] (does not throw) when no roots resolve", () => {
    const results = refreshAllPluginCheckouts({
      now: 0,
      env: {},
      machineConfigPath: "/no/machine.json",
      repoConfigPath: "/no/repo.json",
      readFileFn: () => "{}",
      gitToplevelFn: () => null,
      gitFn: () => "",
      emitFn: () => {},
    });
    expect(results).toEqual([]);
  });
});

// ─── PLUGIN_DRIFT_CHECK_INTERVAL_MS (CTL-1161 Phase 2) ───────────────────────

describe("PLUGIN_DRIFT_CHECK_INTERVAL_MS", () => {
  test("default is 300_000 ms (5 minutes)", () => {
    expect(PLUGIN_DRIFT_CHECK_INTERVAL_MS).toBe(300_000);
  });
});

// ─── startPluginDriftCheck (CTL-1161 Phase 2) ────────────────────────────────
//
// Thin seam-injected wrapper around setInterval, mirroring startWatchdog.

describe("startPluginDriftCheck", () => {
  test("invokes setIntervalFn with the given intervalMs and tickFn", () => {
    let capturedFn = null;
    let capturedMs = null;
    const fakeSetInterval = (fn, ms) => { capturedFn = fn; capturedMs = ms; return 99; };
    const tick = () => {};
    const handle = startPluginDriftCheck({ intervalMs: 12_000, tickFn: tick, setIntervalFn: fakeSetInterval });
    expect(handle).toBe(99);
    expect(capturedFn).toBe(tick);
    expect(capturedMs).toBe(12_000);
  });

  test("uses PLUGIN_DRIFT_CHECK_INTERVAL_MS as default intervalMs", () => {
    let capturedMs = null;
    startPluginDriftCheck({
      tickFn: () => {},
      setIntervalFn: (fn, ms) => { capturedMs = ms; return 1; },
    });
    expect(capturedMs).toBe(PLUGIN_DRIFT_CHECK_INTERVAL_MS);
  });
});

// ─── Coalescing: three triggers → exactly one pull (CTL-1161 Phase 3) ────────
//
// Within one throttle window, a github.push event, a phase.monitor-merge.complete
// event, and a direct refreshAllPluginCheckouts tick must collectively cause
// exactly one git fetch (the throttle collapses them).

describe("coalescing — three triggers in one throttle window", () => {
  beforeEach(() => __clearThrottleForTest());

  test("github.push + phase-complete + drift tick → exactly one git fetch", () => {
    let fetchCount = 0;
    const baseArgs = {
      env: {},
      machineConfigPath: "/no/machine.json",
      repoConfigPath: "/no/repo.json",
      readFileFn: (p) => {
        if (p === "/no/machine.json")
          return JSON.stringify({ catalyst: { orchestration: { pluginDirs: "/co/plugins/dev" } } });
        throw new Error("ENOENT");
      },
      gitToplevelFn: (pd) => pd.replace(/\/plugins\/dev$/, ""),
      gitFn: (root, args) => {
        if (args[0] === "fetch") { fetchCount++; return ""; }
        if (args[0] === "reset") return "";
        if (args[0] === "rev-parse") return fetchCount > 0 ? "new" : "old";
        return "";
      },
      emitFn: () => {},
    };

    // Trigger 1: github.push to main
    handlePluginRefreshEvent({
      ...baseArgs,
      now: 0,
      event: {
        attributes: {
          "event.name": "github.push",
          "vcs.repository.name": "coalesce-labs/catalyst",
          "vcs.ref.name": "main",
        },
      },
      repoFullName: "coalesce-labs/catalyst",
    });

    // Trigger 2: phase.monitor-merge.complete (within throttle window)
    handlePluginRefreshEvent({
      ...baseArgs,
      now: PLUGIN_REFRESH_THROTTLE_MS / 2,
      event: { attributes: { "event.name": "phase.monitor-merge.complete.CTL-1161" } },
      repoFullName: "coalesce-labs/catalyst",
    });

    // Trigger 3: periodic drift-check tick (still within throttle window)
    refreshAllPluginCheckouts({ ...baseArgs, now: PLUGIN_REFRESH_THROTTLE_MS - 1 });

    expect(fetchCount).toBe(1);
  });
});

// ─── changedPackageDirs (CTL-1223) ───────────────────────────────────────────

describe("changedPackageDirs", () => {
  test("returns the dir when ui/package.json changed", () => {
    const dirs = changedPackageDirs("/repo", "plugins/dev/scripts/orch-monitor/ui/package.json\n");
    expect(dirs).toEqual(["/repo/plugins/dev/scripts/orch-monitor/ui"]);
  });

  test("returns the dir when only bun.lock changed", () => {
    const dirs = changedPackageDirs("/repo", "plugins/dev/scripts/orch-monitor/ui/bun.lock\n");
    expect(dirs).toEqual(["/repo/plugins/dev/scripts/orch-monitor/ui"]);
  });

  test("dedupes package.json AND bun.lock in the same dir → exactly one install", () => {
    const diff =
      "plugins/dev/scripts/orch-monitor/ui/package.json\n" +
      "plugins/dev/scripts/orch-monitor/ui/bun.lock\n";
    const dirs = changedPackageDirs("/repo", diff);
    expect(dirs).toHaveLength(1);
    expect(dirs[0]).toBe("/repo/plugins/dev/scripts/orch-monitor/ui");
  });

  test("multiple distinct package dirs changed → one dir per unique package", () => {
    const diff =
      "plugins/dev/scripts/orch-monitor/ui/package.json\n" +
      "plugins/dev/scripts/orch-monitor/bun.lock\n";
    const dirs = changedPackageDirs("/repo", diff);
    expect(dirs).toHaveLength(2);
    expect(new Set(dirs)).toEqual(
      new Set([
        "/repo/plugins/dev/scripts/orch-monitor/ui",
        "/repo/plugins/dev/scripts/orch-monitor",
      ])
    );
  });

  test("no dependency-manifest change → empty array", () => {
    const diff = "plugins/dev/scripts/broker/router.mjs\nsrc/index.ts\n";
    const dirs = changedPackageDirs("/repo", diff);
    expect(dirs).toEqual([]);
  });

  test("empty diff → empty array", () => {
    expect(changedPackageDirs("/repo", "")).toEqual([]);
    expect(changedPackageDirs("/repo", null)).toEqual([]);
  });

  test("root-level package.json maps to root", () => {
    const dirs = changedPackageDirs("/repo", "package.json\n");
    expect(dirs).toEqual(["/repo"]);
  });
});

// ─── refreshPluginCheckout — bun install seam (CTL-1223) ─────────────────────

describe("refreshPluginCheckout — bunInstallFn seam (CTL-1223)", () => {
  beforeEach(() => __clearThrottleForTest());

  // makeGitFnWithDiff: extends makeGitFn to support `diff --name-only` stubbing.
  function makeGitFnWithDiff({ before = "aaaa", after = "bbbb", diffOutput = "" } = {}) {
    const calls = [];
    const gitFn = (root, args) => {
      calls.push({ root, args });
      const sub = args[0];
      if (sub === "rev-parse") {
        const seen = calls.filter((c) => c.args[0] === "rev-parse").length;
        return seen === 1 ? before : after;
      }
      if (sub === "fetch") return "";
      if (sub === "reset") return "";
      if (sub === "diff") return diffOutput;
      return "";
    };
    gitFn.calls = calls;
    return gitFn;
  }

  test("installs in the package dir when ui/package.json changed", () => {
    const installed = [];
    const gitFn = makeGitFnWithDiff({
      diffOutput: "plugins/dev/scripts/orch-monitor/ui/package.json\n",
    });
    refreshPluginCheckout({
      root: "/repo",
      now: 0,
      gitFn,
      emitFn: () => {},
      bunInstallFn: (dir) => { installed.push(dir); },
    });
    expect(installed).toEqual(["/repo/plugins/dev/scripts/orch-monitor/ui"]);
  });

  test("installs when only bun.lock changed", () => {
    const installed = [];
    const gitFn = makeGitFnWithDiff({
      diffOutput: "plugins/dev/scripts/orch-monitor/ui/bun.lock\n",
    });
    refreshPluginCheckout({
      root: "/repo",
      now: 0,
      gitFn,
      emitFn: () => {},
      bunInstallFn: (dir) => { installed.push(dir); },
    });
    expect(installed).toEqual(["/repo/plugins/dev/scripts/orch-monitor/ui"]);
  });

  test("dedupes: package.json AND bun.lock in same dir → exactly one install", () => {
    const installed = [];
    const gitFn = makeGitFnWithDiff({
      diffOutput:
        "plugins/dev/scripts/orch-monitor/ui/package.json\n" +
        "plugins/dev/scripts/orch-monitor/ui/bun.lock\n",
    });
    refreshPluginCheckout({
      root: "/repo",
      now: 0,
      gitFn,
      emitFn: () => {},
      bunInstallFn: (dir) => { installed.push(dir); },
    });
    expect(installed).toHaveLength(1);
  });

  test("multiple distinct package dirs → one install per unique dir", () => {
    const installed = [];
    const gitFn = makeGitFnWithDiff({
      diffOutput:
        "plugins/dev/scripts/orch-monitor/ui/package.json\n" +
        "plugins/dev/scripts/orch-monitor/bun.lock\n",
    });
    refreshPluginCheckout({
      root: "/repo",
      now: 0,
      gitFn,
      emitFn: () => {},
      bunInstallFn: (dir) => { installed.push(dir); },
    });
    expect(installed).toHaveLength(2);
  });

  test("no dependency-manifest change → bunInstallFn NOT called, updated event still emitted", () => {
    const installed = [];
    const emitted = [];
    const gitFn = makeGitFnWithDiff({ diffOutput: "src/index.ts\n" });
    refreshPluginCheckout({
      root: "/repo",
      now: 0,
      gitFn,
      emitFn: (e) => emitted.push(e),
      bunInstallFn: (dir) => { installed.push(dir); },
    });
    expect(installed).toHaveLength(0);
    expect(emitted.some((e) => e.event === "plugin.checkout.updated")).toBe(true);
  });

  test("HEAD unchanged → no diff, no install, no updated event", () => {
    const installed = [];
    const emitted = [];
    const gitFn = makeGitFnWithDiff({ before: "same", after: "same" });
    refreshPluginCheckout({
      root: "/repo",
      now: 0,
      gitFn,
      emitFn: (e) => emitted.push(e),
      bunInstallFn: (dir) => { installed.push(dir); },
    });
    expect(installed).toHaveLength(0);
    expect(emitted).toHaveLength(0);
  });

  test("throttled call → no install", () => {
    const installed = [];
    const gitFn = makeGitFnWithDiff({
      diffOutput: "plugins/dev/scripts/orch-monitor/ui/package.json\n",
    });
    // First call to set throttle
    refreshPluginCheckout({ root: "/repo", now: 0, gitFn, emitFn: () => {}, bunInstallFn: () => {} });
    // Throttled second call
    refreshPluginCheckout({
      root: "/repo",
      now: PLUGIN_REFRESH_THROTTLE_MS - 1,
      gitFn,
      emitFn: () => {},
      bunInstallFn: (dir) => { installed.push(dir); },
    });
    expect(installed).toHaveLength(0);
  });

  test("oldSha null (rev-parse failed) → bunInstallFn NOT called, updated still emitted", () => {
    const installed = [];
    const emitted = [];
    let parseCount = 0;
    const gitFn = (root, args) => {
      if (args[0] === "rev-parse") {
        parseCount++;
        if (parseCount === 1) throw new Error("not a git repo");
        return "newsha";
      }
      if (args[0] === "fetch" || args[0] === "reset") return "";
      return "";
    };
    refreshPluginCheckout({
      root: "/repo",
      now: 0,
      gitFn,
      emitFn: (e) => emitted.push(e),
      bunInstallFn: (dir) => { installed.push(dir); },
    });
    expect(installed).toHaveLength(0);
    expect(emitted.some((e) => e.event === "plugin.checkout.updated")).toBe(true);
  });

  test("bunInstallFn throws → emits deps_install_failed (WARN), still emits updated, result.failed=false", () => {
    const emitted = [];
    const gitFn = makeGitFnWithDiff({
      diffOutput: "plugins/dev/scripts/orch-monitor/ui/package.json\n",
    });
    const res = refreshPluginCheckout({
      root: "/repo",
      now: 0,
      gitFn,
      emitFn: (e) => emitted.push(e),
      bunInstallFn: () => { throw new Error("bun install exploded"); },
    });
    const failEv = emitted.find((e) => e.event === "plugin.checkout.deps_install_failed");
    expect(failEv).toBeDefined();
    expect(failEv.severity).toBe("WARN");
    expect(failEv.detail.package_dir).toBe("/repo/plugins/dev/scripts/orch-monitor/ui");
    expect(emitted.some((e) => e.event === "plugin.checkout.updated")).toBe(true);
    expect(res.failed).toBe(false);
  });

  test("plugin.checkout.updated detail carries deps_installed on the happy path", () => {
    const emitted = [];
    const gitFn = makeGitFnWithDiff({
      diffOutput: "plugins/dev/scripts/orch-monitor/ui/package.json\n",
    });
    refreshPluginCheckout({
      root: "/repo",
      now: 0,
      gitFn,
      emitFn: (e) => emitted.push(e),
      bunInstallFn: () => {},
    });
    const updEv = emitted.find((e) => e.event === "plugin.checkout.updated");
    expect(updEv).toBeDefined();
    expect(Array.isArray(updEv.detail.deps_installed)).toBe(true);
    expect(updEv.detail.deps_installed).toContain("/repo/plugins/dev/scripts/orch-monitor/ui");
  });
});

// ─── workspaceMemberNodeModules + install-time pruning (CTL-1628 follow-up) ──
//
// The workspace conversion moved dep resolution to the ROOT lockfile, but nodes
// migrated in place kept each member's pre-workspace node_modules. Module
// resolution walks UP, so that debris SHADOWS every root install: on the fleet
// this pinned the running cloud-sync daemon to @catalyst-cloud/sdk 0.8.0 (no
// CTC-328 stale-frame guard) while the root lock said 0.8.1 and every refresh
// "succeeded". The prune runs ONLY immediately before an install — bun
// recreates any nested layout it legitimately needs, which is what makes a
// false positive harmless — and never on a bare tick.

function makeWorkspaceFs({
  workspaces = ["plugins/dev/scripts/execution-core"],
  rootLock = true,
  members = {},
} = {}) {
  // members: { "<entry>": { pkg: true, lock: false, nodeModules: true } }
  const files = new Set();
  const contents = new Map();
  contents.set("/co/package.json", JSON.stringify({ workspaces }));
  files.add("/co/package.json");
  if (rootLock) files.add("/co/bun.lock");
  for (const [entry, m] of Object.entries(members)) {
    if (m.pkg !== false) files.add(`/co/${entry}/package.json`);
    if (m.lock) files.add(`/co/${entry}/bun.lock`);
    if (m.nodeModules !== false) files.add(`/co/${entry}/node_modules`);
  }
  return {
    readFileFn: (path) => {
      const key = String(path);
      if (!contents.has(key)) throw new Error(`ENOENT: ${key}`);
      return contents.get(key);
    },
    existsFn: (path) => files.has(String(path)),
  };
}

describe("workspaceMemberNodeModules", () => {
  test("returns a member's node_modules when the member has no lockfile of its own", () => {
    const fs = makeWorkspaceFs({
      members: { "plugins/dev/scripts/execution-core": { nodeModules: true } },
    });
    expect(workspaceMemberNodeModules("/co", fs)).toEqual([
      "/co/plugins/dev/scripts/execution-core/node_modules",
    ]);
  });

  test("skips a member that manages itself (own bun.lock) — that is not workspace debris", () => {
    const fs = makeWorkspaceFs({
      members: { "plugins/dev/scripts/execution-core": { nodeModules: true, lock: true } },
    });
    expect(workspaceMemberNodeModules("/co", fs)).toEqual([]);
  });

  test("returns [] when the ROOT has no bun.lock — without an authoritative root lock, nothing is ours to prune", () => {
    const fs = makeWorkspaceFs({
      rootLock: false,
      members: { "plugins/dev/scripts/execution-core": { nodeModules: true } },
    });
    expect(workspaceMemberNodeModules("/co", fs)).toEqual([]);
  });

  test("returns [] for a non-workspace root, and skips glob entries rather than expanding them", () => {
    const noWs = makeWorkspaceFs({ workspaces: [] });
    expect(workspaceMemberNodeModules("/co", noWs)).toEqual([]);

    // A glob entry must NOT silently become an rm -rf fan-out.
    const glob = makeWorkspaceFs({
      workspaces: ["packages/*"],
      members: { "packages/a": { nodeModules: true } },
    });
    expect(workspaceMemberNodeModules("/co", glob)).toEqual([]);
  });

  test("an unreadable root package.json yields [] rather than a throw — refresh must not die on it", () => {
    expect(
      workspaceMemberNodeModules("/co", {
        readFileFn: () => {
          throw new Error("EACCES");
        },
        existsFn: () => true,
      }),
    ).toEqual([]);
  });
});

describe("refreshPluginCheckout — stale node_modules pruning", () => {
  beforeEach(() => {
    __clearThrottleForTest();
    __clearLagStateForTest();
  });

  // A gitFn whose diff reports the root lockfile changed → install will run at root.
  function makeGitFnWithDiff(diffLines) {
    const inner = makeGitFn({ before: "old111", after: "new222" });
    const gitFn = (root, args) => {
      if (args[0] === "diff") return diffLines.join("\n");
      return inner(root, args);
    };
    gitFn.calls = inner.calls;
    return gitFn;
  }

  test("prunes stale member node_modules BEFORE the install, and says so in the updated event", () => {
    const emitted = [];
    const order = [];
    const res = refreshPluginCheckout({
      root: "/co",
      now: 0,
      gitFn: makeGitFnWithDiff(["bun.lock"]),
      memberNodeModulesFn: () => ["/co/plugins/dev/scripts/execution-core/node_modules"],
      pruneFn: (dir) => order.push(`prune:${dir}`),
      bunInstallFn: (dir) => order.push(`install:${dir}`),
      emitFn: (e) => emitted.push(e),
    });

    expect(res.failed).toBe(false);
    // ORDER is the point: pruning after the install would leave the shadow in place.
    expect(order).toEqual([
      "prune:/co/plugins/dev/scripts/execution-core/node_modules",
      "install:/co",
    ]);
    const updated = emitted.find((e) => e.event === "plugin.checkout.updated");
    expect(updated.detail.stale_node_modules_pruned).toEqual([
      "/co/plugins/dev/scripts/execution-core/node_modules",
    ]);
    expect(updated.detail.deps_installed).toEqual(["/co"]);
  });

  test("does NOT prune on a pull with no manifest changes — never on a bare tick", () => {
    const pruned = [];
    refreshPluginCheckout({
      root: "/co",
      now: 0,
      gitFn: makeGitFnWithDiff(["some/other/file.mjs"]),
      memberNodeModulesFn: () => ["/co/plugins/dev/scripts/execution-core/node_modules"],
      pruneFn: (dir) => pruned.push(dir),
      bunInstallFn: () => {},
      emitFn: () => {},
    });
    expect(pruned).toEqual([]);
  });

  test("a prune failure WARNs and the install still runs — same non-fatal contract as install failures", () => {
    const emitted = [];
    const installed = [];
    refreshPluginCheckout({
      root: "/co",
      now: 0,
      gitFn: makeGitFnWithDiff(["bun.lock"]),
      memberNodeModulesFn: () => ["/co/x/node_modules"],
      pruneFn: () => {
        throw new Error("EPERM: operation not permitted");
      },
      bunInstallFn: (dir) => installed.push(dir),
      emitFn: (e) => emitted.push(e),
    });

    const warn = emitted.find((e) => e.event === "plugin.checkout.node_modules_prune_failed");
    expect(warn.severity).toBe("WARN");
    expect(warn.detail.node_modules_dir).toBe("/co/x/node_modules");
    expect(warn.detail.error).toContain("EPERM");
    expect(installed).toEqual(["/co"]); // the checkout still converges as far as it can
  });
});

// ─── clearStaleIndexLock (CTL-1415) ──────────────────────────────────────────
//
// A crashed git op leaves .git/index.lock behind and every later reset --hard
// then fails forever (the ~8.5h laptop freeze in CTL-1401). The pull path
// age-gate clears ONLY a lock older than the safe threshold (a live op is never
// disturbed), emits a WARN when it clears, and never throws.

const LOCK_NOW = 1_750_000_000_000;
const LOCK_ROOT = "/co/plugin-source";
const LOCK_PATH = "/co/plugin-source/.git/index.lock";

// statFn seam: returns a fixed mtime for the lock path, null (absent) otherwise.
function makeLockStatFn(mtimeMs) {
  return (path) => (path === LOCK_PATH && mtimeMs != null ? mtimeMs : null);
}

describe("clearStaleIndexLock", () => {
  test("no lock → no removal, no event", () => {
    const emitted = [];
    const removed = [];
    const res = clearStaleIndexLock({
      root: LOCK_ROOT, now: LOCK_NOW,
      emitFn: (e) => emitted.push(e),
      statFn: makeLockStatFn(null),
      rmFn: (p) => removed.push(p),
    });
    expect(res.present).toBe(false);
    expect(res.cleared).toBe(false);
    expect(removed).toEqual([]);
    expect(emitted).toEqual([]);
  });

  test("fresh lock (live git op) → NOT removed, no event", () => {
    const emitted = [];
    const removed = [];
    const res = clearStaleIndexLock({
      root: LOCK_ROOT, now: LOCK_NOW, thresholdMs: 600_000,
      emitFn: (e) => emitted.push(e),
      statFn: makeLockStatFn(LOCK_NOW - 5_000), // 5s old
      rmFn: (p) => removed.push(p),
    });
    expect(res.present).toBe(true);
    expect(res.stale).toBe(false);
    expect(res.cleared).toBe(false);
    expect(removed).toEqual([]);
    expect(emitted).toEqual([]);
  });

  test("stale lock → removed + plugin.checkout.stale_lock_cleared (WARN)", () => {
    const emitted = [];
    const removed = [];
    const res = clearStaleIndexLock({
      root: LOCK_ROOT, now: LOCK_NOW, thresholdMs: 600_000,
      emitFn: (e) => emitted.push(e),
      statFn: makeLockStatFn(LOCK_NOW - 8.5 * 60 * 60 * 1000), // 8.5h old
      rmFn: (p) => removed.push(p),
    });
    expect(res.cleared).toBe(true);
    expect(removed).toEqual([LOCK_PATH]);
    const ev = emitted.find((e) => e.event === "plugin.checkout.stale_lock_cleared");
    expect(ev).toBeDefined();
    expect(ev.severity).toBe("WARN");
    expect(ev.detail.checkout).toBe(LOCK_ROOT);
    expect(ev.detail.lock_age_ms).toBeGreaterThanOrEqual(600_000);
    expect(ev.detail.threshold_ms).toBe(600_000);
  });

  test("removal failure → stale_lock_clear_failed (WARN), never throws", () => {
    const emitted = [];
    const res = clearStaleIndexLock({
      root: LOCK_ROOT, now: LOCK_NOW, thresholdMs: 600_000,
      emitFn: (e) => emitted.push(e),
      statFn: makeLockStatFn(LOCK_NOW - 3_600_000), // 1h old → stale
      rmFn: () => { throw new Error("EACCES"); },
    });
    expect(res.cleared).toBe(false);
    expect(res.error).toContain("EACCES");
    const ev = emitted.find((e) => e.event === "plugin.checkout.stale_lock_clear_failed");
    expect(ev).toBeDefined();
    expect(ev.severity).toBe("WARN");
  });

  // Codex P1 (#2530): a concurrent cleanup attempt could classify the SAME old
  // lock as stale, then lose a race to a different attempt that already cleared
  // it and started a new git op (a fresh index.lock). The re-check right before
  // removal must see that the lock is no longer present-and-stale and bail out
  // — never unlinking a lock a live git op now holds.
  test("re-check race: lock no longer stale by removal time → NOT removed, no event", () => {
    const emitted = [];
    const removed = [];
    let calls = 0;
    // First staleLockStatus call (classification) sees the old stale lock;
    // second call (the pre-removal re-check) sees a brand-new fresh lock —
    // simulating another process having cleared+restarted git in between.
    const statFn = (path) => {
      calls += 1;
      if (path !== LOCK_PATH) return null;
      return calls === 1 ? LOCK_NOW - 3_600_000 : LOCK_NOW; // 1h stale, then 0s fresh
    };
    const res = clearStaleIndexLock({
      root: LOCK_ROOT, now: LOCK_NOW, thresholdMs: 600_000,
      emitFn: (e) => emitted.push(e),
      statFn,
      rmFn: (p) => removed.push(p),
    });
    expect(res.cleared).toBe(false);
    expect(removed).toEqual([]);
    expect(emitted).toEqual([]);
    expect(calls).toBeGreaterThanOrEqual(2); // both the classification and the re-check ran
  });

  test("re-check race: lock disappears entirely by removal time (already cleared) → NOT removed, no event", () => {
    const emitted = [];
    const removed = [];
    let calls = 0;
    const statFn = (path) => {
      calls += 1;
      if (path !== LOCK_PATH) return null;
      return calls === 1 ? LOCK_NOW - 3_600_000 : null; // stale, then gone
    };
    const res = clearStaleIndexLock({
      root: LOCK_ROOT, now: LOCK_NOW, thresholdMs: 600_000,
      emitFn: (e) => emitted.push(e),
      statFn,
      rmFn: (p) => removed.push(p),
    });
    expect(res.cleared).toBe(false);
    expect(removed).toEqual([]);
    expect(emitted).toEqual([]);
  });
});

describe("refreshPluginCheckout — stale-lock pre-pull clear (CTL-1415)", () => {
  beforeEach(() => __clearThrottleForTest());

  test("clears a stale lock before fetch/reset, then pulls", () => {
    const emitted = [];
    const removed = [];
    const gitFn = makeGitFn({ before: "old111", after: "new222" });
    const res = refreshPluginCheckout({
      root: LOCK_ROOT, now: LOCK_NOW, gitFn,
      emitFn: (e) => emitted.push(e),
      statFn: makeLockStatFn(LOCK_NOW - 3_600_000), // 1h stale
      rmFn: (p) => removed.push(p),
      bunInstallFn: () => {},
    });
    // Lock cleared, and the pull proceeded to a real reset + updated event.
    expect(removed).toEqual([LOCK_PATH]);
    expect(emitted.some((e) => e.event === "plugin.checkout.stale_lock_cleared")).toBe(true);
    expect(gitFn.calls.some((c) => c.args[0] === "reset")).toBe(true);
    expect(res.pulled).toBe(true);
    expect(res.changed).toBe(true);
  });

  test("does NOT touch a fresh lock (live op), still attempts the pull", () => {
    const emitted = [];
    const removed = [];
    const gitFn = makeGitFn({ before: "old111", after: "new222" });
    refreshPluginCheckout({
      root: LOCK_ROOT, now: LOCK_NOW, gitFn,
      emitFn: (e) => emitted.push(e),
      statFn: makeLockStatFn(LOCK_NOW - 3_000), // 3s fresh
      rmFn: (p) => removed.push(p),
      bunInstallFn: () => {},
    });
    expect(removed).toEqual([]);
    expect(emitted.some((e) => e.event === "plugin.checkout.stale_lock_cleared")).toBe(false);
    expect(gitFn.calls.some((c) => c.args[0] === "fetch")).toBe(true);
  });
});

// ─── install-must-relink (CTL-1831) ─────────────────────────────────────────
//
// MEASURED on `mini` 2026-08-13, right after #3337 moved bun.lock from
// @catalyst-cloud/schema@0.1.3 to 0.1.5. The refresh pulled the merge correctly
// (plugin-source HEAD and bun.lock both right) and the daemons STILL loaded
// 0.1.3, because bun does not relink an existing node_modules when only a
// TRANSITIVE resolution changed — and both `--frozen-lockfile` and the plain
// fallback exit 0 while doing nothing. `deps_install_failed` covers a FAILING
// install; a no-op produced no signal at all. These tests pin the signal, the
// forced relink, and — critically — that the force fires ONLY on a proven
// mismatch (a blanket --force re-extracts 1168 packages, 3-8 s measured, on
// every single refresh).

describe("changedLockfiles (CTL-1831)", () => {
  test("maps a root bun.lock change to the checkout root", () => {
    expect(changedLockfiles("/repo", "bun.lock\n")).toEqual([{ rel: "bun.lock", dir: "/repo" }]);
  });

  test("maps a nested bun.lock change to its own dir", () => {
    expect(changedLockfiles("/repo", "plugins/dev/scripts/orch-monitor/ui/bun.lock\n")).toEqual([
      {
        rel: "plugins/dev/scripts/orch-monitor/ui/bun.lock",
        dir: "/repo/plugins/dev/scripts/orch-monitor/ui",
      },
    ]);
  });

  test("a package.json-only change yields no lockfile to audit", () => {
    expect(changedLockfiles("/repo", "package.json\nsrc/index.ts\n")).toEqual([]);
  });

  test("does not match a file merely ENDING in bun.lock", () => {
    expect(changedLockfiles("/repo", "vendor/notbun.lock\n")).toEqual([]);
  });

  test("dedupes a repeated path and tolerates empty input", () => {
    expect(changedLockfiles("/repo", "bun.lock\nbun.lock\n")).toHaveLength(1);
    expect(changedLockfiles("/repo", "")).toEqual([]);
    expect(changedLockfiles("/repo", null)).toEqual([]);
  });
});

describe("bunInstallArgv (CTL-1831)", () => {
  test("frozen is the default — the checkout was just reset, so the lockfile IS authoritative", () => {
    expect(bunInstallArgv()).toEqual(["install", "--frozen-lockfile"]);
  });

  test("the non-frozen fallback drops the flag rather than adding another", () => {
    expect(bunInstallArgv({ frozen: false })).toEqual(["install"]);
  });

  test("force is the only argv that actually relinks a transitive-only change", () => {
    expect(bunInstallArgv({ force: true })).toEqual(["install", "--force"]);
  });
});

describe("workspaceRootsFor (CTL-1831)", () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ctl1831-roots-"));
  });

  test("the lock dir itself is always a root, even with no manifest", () => {
    expect(workspaceRootsFor(dir)).toEqual([{ dir, name: null }]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("literal workspace members with a package.json are added", () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ workspaces: ["pkg/a", "pkg/b"] }));
    mkdirSync(join(dir, "pkg", "a"), { recursive: true });
    writeFileSync(join(dir, "pkg", "a", "package.json"), "{}");
    // pkg/b has no package.json → not a member dir anything can resolve from.
    expect(workspaceRootsFor(dir)).toEqual([
      { dir, name: null },
      { dir: join(dir, "pkg", "a"), name: null },
    ]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("each root carries its own package NAME — the discriminator the bare-key audit sheds a nested member with", () => {
    // Without the name the audit cannot tell WHICH member root a `<member>/<id>`
    // lock key shadows, and falls back to shedding every nameless root. Mutating
    // either `manifestNameAt` call site to `null` fails this assertion.
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "the-root", workspaces: ["pkg/named", "pkg/nameless", "pkg/broken"] }),
    );
    mkdirSync(join(dir, "pkg", "named"), { recursive: true });
    writeFileSync(join(dir, "pkg", "named", "package.json"), JSON.stringify({ name: "member-ui" }));
    mkdirSync(join(dir, "pkg", "nameless"), { recursive: true });
    writeFileSync(join(dir, "pkg", "nameless", "package.json"), "{}");
    // A member whose manifest EXISTS but does not parse is still a resolvable
    // dir — membership stays keyed on existence, the name is what degrades.
    mkdirSync(join(dir, "pkg", "broken"), { recursive: true });
    writeFileSync(join(dir, "pkg", "broken", "package.json"), "{ not json");
    expect(workspaceRootsFor(dir)).toEqual([
      { dir, name: "the-root" },
      { dir: join(dir, "pkg", "named"), name: "member-ui" },
      { dir: join(dir, "pkg", "nameless"), name: null },
      { dir: join(dir, "pkg", "broken"), name: null },
    ]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a GLOB entry is skipped, not expanded — and not merely dropped for the wrong reason", () => {
    // TWO decoys, killing two different mutations, because either one alone
    // leaves the assertion passing on broken code:
    //
    //   packages/*  — a directory LITERALLY named "*" (a legal filename), with a
    //     package.json. Deleting the `entry.includes("*")` guard does not add
    //     glob EXPANSION, so without this decoy the literal path `packages/*`
    //     simply has no package.json and is dropped by the existsFn check on the
    //     next line — the right answer for the wrong reason, and the guard
    //     survives its own mutation. With the decoy, dropping the guard admits
    //     `<dir>/packages/*` as a root and the assertion fails.
    //   packages/y  — a real package dir reachable ONLY by expanding the glob, so
    //     an implementation that started expanding globs also fails.
    writeFileSync(join(dir, "package.json"), JSON.stringify({ workspaces: ["packages/*", "packages/x"] }));
    mkdirSync(join(dir, "packages", "x"), { recursive: true });
    writeFileSync(join(dir, "packages", "x", "package.json"), "{}");
    mkdirSync(join(dir, "packages", "y"), { recursive: true });
    writeFileSync(join(dir, "packages", "y", "package.json"), "{}");
    mkdirSync(join(dir, "packages", "*"), { recursive: true });
    writeFileSync(join(dir, "packages", "*", "package.json"), "{}");
    expect(workspaceRootsFor(dir)).toEqual([
      { dir, name: null },
      { dir: join(dir, "packages", "x"), name: null },
    ]);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ─── defaultResolvePackageFn (CTL-1831) ──────────────────────────────────────
//
// The one component of the audit that touches disk, and — until this block — the
// one with no coverage at all: every audit test injects a fake resolvePackageFn
// and every refresh test injects a fake auditFn, so the production probe was
// exercised by nothing. It shipped answering from Node's PROCESS-WIDE module
// resolution cache, which made the post-force RE-audit report a FALSE
// deps_relink_failed on every real repair and made a long-lived daemon
// permanently blind to a tree that went stale after its first clean audit.
// These tests run against a REAL temp tree in the isolated-linker layout the
// incident occurred in.

// isolatedTree — a minimal bun isolated-linker layout:
//   node_modules/.bun/<pkg>@<ver>/node_modules/<pkg>/     the real copies
//   node_modules/<pkg>                        -> symlink into the store
// linkTo(pkg, ver) repoints that symlink, which is exactly what an install does
// when it relinks a moved resolution.
function isolatedTree(versionsByPkg) {
  const root = mkdtempSync(join(tmpdir(), "ctl1831-tree-"));
  const store = join(root, "node_modules", ".bun");
  mkdirSync(store, { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "host", version: "1.0.0" }));
  for (const [pkg, versions] of Object.entries(versionsByPkg)) {
    for (const version of versions) {
      const dir = join(store, `${pkg.replace("/", "+")}@${version}`, "node_modules", ...pkg.split("/"));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: pkg, version }));
    }
  }
  const linkTo = (fromDir, pkg, version) => {
    const at = join(fromDir, "node_modules", ...pkg.split("/"));
    mkdirSync(join(at, ".."), { recursive: true });
    try {
      rmSync(at, { force: true, recursive: false });
    } catch {
      /* first link — nothing to remove */
    }
    symlinkSync(join(store, `${pkg.replace("/", "+")}@${version}`, "node_modules", ...pkg.split("/")), at, "dir");
  };
  const storeDirOf = (pkg, version) =>
    join(store, `${pkg.replace("/", "+")}@${version}`, "node_modules", ...pkg.split("/"));
  return { root, store, linkTo, storeDirOf, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("defaultResolvePackageFn (CTL-1831)", () => {
  test("reads the version off the entry the importer's node_modules actually points at", () => {
    const t = isolatedTree({ "@scope/dep": ["0.1.3", "0.1.5"] });
    t.linkTo(t.root, "@scope/dep", "0.1.5");
    const got = defaultResolvePackageFn(t.root, "@scope/dep");
    expect(got.version).toBe("0.1.5");
    // dir is the realpath'd STORE entry, not the link — a mismatch report has to
    // name the bytes, since both versions sit in the store simultaneously.
    expect(got.dir).toBe(realpathSync(t.storeDirOf("@scope/dep", "0.1.5")));
    t.cleanup();
  });

  test("THE DEFECT: a SECOND call in the SAME process sees the relink — no resolution cache in the path", () => {
    // This is F2 at the unit altitude, and the assertion the shipped probe could
    // not pass: createRequire().resolve() answers from a process-wide cache that
    // a fresh createRequire does not clear. Measured pre-fix, one process:
    //   before: symlink 0.1.5 -> resolve 0.1.5 | after flip: symlink 0.1.3 -> resolve 0.1.5
    const t = isolatedTree({ "@scope/dep": ["0.1.3", "0.1.5"] });
    t.linkTo(t.root, "@scope/dep", "0.1.5");
    expect(defaultResolvePackageFn(t.root, "@scope/dep").version).toBe("0.1.5");
    t.linkTo(t.root, "@scope/dep", "0.1.3");
    expect(defaultResolvePackageFn(t.root, "@scope/dep").version).toBe("0.1.3");
    // …and back again, so the test cannot pass on an implementation that merely
    // caches the LAST answer rather than the first.
    t.linkTo(t.root, "@scope/dep", "0.1.5");
    expect(defaultResolvePackageFn(t.root, "@scope/dep").version).toBe("0.1.5");
    t.cleanup();
  });

  test("the incident's own shape: the schema resolved THROUGH the SDK, with no top-level copy", () => {
    // Under the isolated linker the workspace root has no @scope/schema at all,
    // so a top-level probe reports "absent" and never sees what the daemon loads.
    const t = isolatedTree({ "@scope/sdk": ["0.8.2"], "@scope/schema": ["0.1.3", "0.1.5"] });
    t.linkTo(t.root, "@scope/sdk", "0.8.2");
    const sdkDir = t.storeDirOf("@scope/sdk", "0.8.2");
    t.linkTo(sdkDir, "@scope/schema", "0.1.3");
    expect(defaultResolvePackageFn(t.root, "@scope/schema")).toBeNull();
    const sdk = defaultResolvePackageFn(t.root, "@scope/sdk");
    expect(defaultResolvePackageFn(sdk.dir, "@scope/schema").version).toBe("0.1.3");
    t.cleanup();
  });

  test("climbs the node_modules ladder — a nested importer resolves the parent's copy", () => {
    const t = isolatedTree({ "@scope/dep": ["0.1.5"] });
    t.linkTo(t.root, "@scope/dep", "0.1.5");
    const deep = join(t.root, "packages", "a", "src");
    mkdirSync(deep, { recursive: true });
    expect(defaultResolvePackageFn(deep, "@scope/dep").version).toBe("0.1.5");
    t.cleanup();
  });

  test("an id with no entry anywhere up the ladder is null — not a guessed version", () => {
    const t = isolatedTree({ "@scope/dep": ["0.1.5"] });
    t.linkTo(t.root, "@scope/dep", "0.1.5");
    expect(defaultResolvePackageFn(t.root, "@scope/absent")).toBeNull();
    t.cleanup();
  });

  test("a manifest with no usable version is null — the audit reads that as 'could not look'", () => {
    const t = isolatedTree({});
    const at = join(t.root, "node_modules", "broken");
    mkdirSync(at, { recursive: true });
    writeFileSync(join(at, "package.json"), JSON.stringify({ name: "broken" })); // no version
    expect(defaultResolvePackageFn(t.root, "broken")).toBeNull();
    writeFileSync(join(at, "package.json"), "{not json");
    expect(defaultResolvePackageFn(t.root, "broken")).toBeNull();
    t.cleanup();
  });

  test("a realpath failure keeps the literal path — the VERSION is the verdict, never nulled", () => {
    const t = isolatedTree({ "@scope/dep": ["0.1.5"] });
    t.linkTo(t.root, "@scope/dep", "0.1.5");
    const got = defaultResolvePackageFn(t.root, "@scope/dep", {
      realpathFn: () => {
        throw new Error("EACCES");
      },
    });
    expect(got.version).toBe("0.1.5");
    expect(got.dir).toBe(join(t.root, "node_modules", "@scope", "dep"));
    t.cleanup();
  });

  test("a missing or non-string argument is null, never a probe of the wrong directory", () => {
    expect(defaultResolvePackageFn("", "dep")).toBeNull();
    expect(defaultResolvePackageFn(null, "dep")).toBeNull();
    expect(defaultResolvePackageFn("/tmp", "")).toBeNull();
    expect(defaultResolvePackageFn("/tmp", undefined)).toBeNull();
  });
});

// ─── the audit end-to-end, against a REAL tree (CTL-1831) ────────────────────
//
// Every other refresh test injects auditFn, so the wiring was proven while the
// thing being wired was not. These drive the SHIPPED refreshPluginCheckout with
// resolvePackageFn / workspaceRootsFn / readFileFn / auditFn ALL at their
// production defaults; only gitFn and bunInstallFn are faked, because the alt
// is a network fetch and a 5 s 1168-package extract.

describe("refreshPluginCheckout — audit against a REAL node_modules (CTL-1831)", () => {
  const SCHEMA = "@scope/schema";
  const SDK = "@scope/sdk";

  // A bun.lock `packages` block in the real emitted shape (see this repo's own
  // bun.lock): `"<key>": ["<name>@<version>", "<resolution>", {<meta>}, "<sha>"],`
  const lockText = (schemaVersion) =>
    [
      "{",
      '  "lockfileVersion": 1,',
      '  "packages": {',
      `    "${SCHEMA}": ["${SCHEMA}@${schemaVersion}", "", {}, "sha512-aaa"],`,
      `    "${SDK}": ["${SDK}@0.8.2", "", { "dependencies": { "${SCHEMA}": "^0.1.3" } }, "sha512-bbb"],`,
      "  }",
      "}",
      "",
    ].join("\n");

  // The incident's tree: the SDK is the only importer of the schema, and the
  // schema link under the SDK is what a relink moves.
  function incidentTree(schemaOnDisk) {
    const t = isolatedTree({ [SDK]: ["0.8.2"], [SCHEMA]: ["0.1.3", "0.1.5"] });
    t.linkTo(t.root, SDK, "0.8.2");
    t.linkTo(t.storeDirOf(SDK, "0.8.2"), SCHEMA, schemaOnDisk);
    writeFileSync(join(t.root, "bun.lock"), lockText("0.1.5")); // post-pull lockfile
    return t;
  }

  function runRefresh(t, { forceRelinksTo = null } = {}) {
    __clearThrottleForTest();
    const emitted = [];
    const installs = [];
    let revParse = 0;
    return {
      emitted,
      installs,
      res: refreshPluginCheckout({
        root: t.root,
        now: Date.now(),
        loadedCommit: null,
        emitFn: (e) => emitted.push(e),
        memberNodeModulesFn: () => [],
        pruneFn: () => {},
        gitFn: (_root, args) => {
          if (args[0] === "rev-parse") return (revParse += 1) === 1 ? "oldsha" : "newsha";
          if (args[0] === "diff") return "bun.lock\n";
          if (args[0] === "show") return lockText("0.1.3"); // pre-pull lockfile
          return "";
        },
        bunInstallFn: (_dir, opts) => {
          installs.push(opts ?? null);
          // Model bun exactly: the plain install is the measured NO-OP; only
          // --force moves the link.
          if (opts?.force && forceRelinksTo) t.linkTo(t.storeDirOf(SDK, "0.8.2"), SCHEMA, forceRelinksTo);
        },
      }),
    };
  }

  test("a stale tree is DETECTED through the real resolver — deps_install_noop names the found version", () => {
    const t = incidentTree("0.1.3");
    const { emitted } = runRefresh(t);
    const noop = emitted.find((e) => e.event === "plugin.checkout.deps_install_noop");
    expect(noop).toBeDefined();
    expect(noop.detail.mismatched[0].id).toBe(SCHEMA);
    expect(noop.detail.mismatched[0].found).toEqual(["0.1.3"]);
    expect(noop.detail.mismatched[0].expected).toBe("0.1.5");
    expect(noop.detail.mismatched[0].importers).toContain(SDK);
    t.cleanup();
  });

  test("a REPAIR reports success: force fires, the re-audit sees the new bytes, deps_relinked is non-empty", () => {
    // F1. Pre-fix this emitted deps_relink_failed (ERROR, documented as
    // unfixable) with deps_relinked:[] even though the force HAD relinked the
    // tree — the re-audit was answering from the cache the first audit filled.
    const t = incidentTree("0.1.3");
    const { emitted, installs } = runRefresh(t, { forceRelinksTo: "0.1.5" });
    expect(installs).toEqual([null, { force: true }]);
    expect(emitted.some((e) => e.event === "plugin.checkout.deps_relink_failed")).toBe(false);
    expect(emitted.find((e) => e.event === "plugin.checkout.updated").detail.deps_relinked).toEqual([t.root]);
    t.cleanup();
  });

  test("a force that genuinely does not fix it still reports deps_relink_failed", () => {
    // The other side of the same edge: the ERROR must stay reachable, or the fix
    // above would have bought a detector that can never say no.
    const t = incidentTree("0.1.3");
    const { emitted } = runRefresh(t, { forceRelinksTo: null });
    const fail = emitted.find((e) => e.event === "plugin.checkout.deps_relink_failed");
    expect(fail).toBeDefined();
    expect(fail.severity).toBe("ERROR");
    expect(emitted.find((e) => e.event === "plugin.checkout.updated").detail.deps_relinked).toEqual([]);
    t.cleanup();
  });

  test("TWO refreshes in ONE process: a clean pass does not blind the next one to a tree that went stale", () => {
    // F2. Pre-fix, pass 2 returned CLEAN with a single non-forced install — the
    // long-lived updater/broker daemon (setInterval) could never see an incident
    // that began after its first successful audit.
    const t = incidentTree("0.1.5"); // pass 1: the tree is CORRECT
    const first = runRefresh(t);
    expect(first.installs).toEqual([null]);
    expect(first.emitted.some((e) => e.event === "plugin.checkout.deps_install_noop")).toBe(false);

    t.linkTo(t.storeDirOf(SDK, "0.8.2"), SCHEMA, "0.1.3"); // the tree goes stale
    const second = runRefresh(t, { forceRelinksTo: "0.1.5" });
    const noop = second.emitted.find((e) => e.event === "plugin.checkout.deps_install_noop");
    expect(noop).toBeDefined();
    expect(noop.detail.mismatched[0].found).toEqual(["0.1.3"]);
    expect(second.installs).toEqual([null, { force: true }]);
    t.cleanup();
  });

  test("a correct tree stays quiet — no noop, no force, no inconclusive", () => {
    // The positive control for every negative above: the same instrument on a
    // tree known to be right returns a clean verdict, so a CLEAN result means
    // "looked and found nothing", not "could not look".
    const t = incidentTree("0.1.5");
    const { emitted, installs } = runRefresh(t);
    expect(installs).toEqual([null]);
    const names = emitted.map((e) => e.event);
    expect(names).not.toContain("plugin.checkout.deps_install_noop");
    expect(names).not.toContain("plugin.checkout.deps_audit_inconclusive");
    expect(names).toContain("plugin.checkout.updated");
    t.cleanup();
  });
});

describe("refreshPluginCheckout — post-install resolution audit (CTL-1831)", () => {
  beforeEach(() => __clearThrottleForTest());

  const OLD_LOCK = "OLD-LOCK-TEXT";
  const NEW_LOCK = "NEW-LOCK-TEXT";

  // git stub that also answers `show <sha>:<path>` with the pre-pull lockfile.
  function makeAuditGitFn({ diffOutput = "bun.lock\n" } = {}) {
    const calls = [];
    const gitFn = (root, args) => {
      calls.push({ root, args });
      const sub = args[0];
      if (sub === "rev-parse") {
        const seen = calls.filter((c) => c.args[0] === "rev-parse").length;
        return seen === 1 ? "oldsha" : "newsha";
      }
      if (sub === "diff") return diffOutput;
      if (sub === "show") return OLD_LOCK;
      return "";
    };
    gitFn.calls = calls;
    return gitFn;
  }

  const MISMATCH = {
    conclusive: true,
    reason: null,
    checked: 1,
    matched: [],
    mismatched: [
      {
        key: "@catalyst-cloud/schema",
        id: "@catalyst-cloud/schema",
        from: "0.1.3",
        to: "0.1.5",
        expected: "0.1.5",
        found: ["0.1.3"],
        importers: ["@catalyst-cloud/sdk"],
        paths: [],
      },
    ],
    inconclusive: [],
  };
  const CLEAN = {
    conclusive: true,
    reason: null,
    checked: 1,
    matched: [{}],
    mismatched: [],
    inconclusive: [],
  };

  // baseArgs — everything refreshPluginCheckout needs to reach the audit.
  function baseArgs(overrides = {}) {
    return {
      root: "/repo",
      now: 0,
      emitFn: () => {},
      readFileFn: () => NEW_LOCK,
      workspaceRootsFn: () => ["/repo"],
      resolvePackageFn: () => null,
      ...overrides,
    };
  }

  test("a CLEAN audit runs the install exactly once — no --force, no noop event", () => {
    const installs = [];
    const emitted = [];
    refreshPluginCheckout(
      baseArgs({
        gitFn: makeAuditGitFn(),
        emitFn: (e) => emitted.push(e),
        bunInstallFn: (dir, opts) => installs.push({ dir, opts }),
        auditFn: () => CLEAN,
      }),
    );
    expect(installs).toHaveLength(1);
    expect(installs[0].opts?.force).toBeFalsy();
    expect(emitted.some((e) => e.event === "plugin.checkout.deps_install_noop")).toBe(false);
  });

  test("THE DEFECT: a mismatch after a 0-exit install emits deps_install_noop (WARN) naming the importer", () => {
    const emitted = [];
    refreshPluginCheckout(
      baseArgs({
        gitFn: makeAuditGitFn(),
        emitFn: (e) => emitted.push(e),
        bunInstallFn: () => {},
        auditFn: () => MISMATCH,
      }),
    );
    const ev = emitted.find((e) => e.event === "plugin.checkout.deps_install_noop");
    expect(ev).toBeDefined();
    expect(ev.severity).toBe("WARN");
    expect(ev.detail.package_dir).toBe("/repo");
    expect(ev.detail.mismatched[0].id).toBe("@catalyst-cloud/schema");
    expect(ev.detail.mismatched[0].importers).toContain("@catalyst-cloud/sdk");
  });

  test("a mismatch triggers a SECOND install with force:true", () => {
    const installs = [];
    let audits = 0;
    refreshPluginCheckout(
      baseArgs({
        gitFn: makeAuditGitFn(),
        bunInstallFn: (dir, opts) => installs.push({ dir, opts }),
        auditFn: () => (++audits === 1 ? MISMATCH : CLEAN),
      }),
    );
    expect(installs).toHaveLength(2);
    expect(installs[1]).toEqual({ dir: "/repo", opts: { force: true } });
  });

  test("a successful relink lands in plugin.checkout.updated → deps_relinked", () => {
    const emitted = [];
    let audits = 0;
    refreshPluginCheckout(
      baseArgs({
        gitFn: makeAuditGitFn(),
        emitFn: (e) => emitted.push(e),
        bunInstallFn: () => {},
        auditFn: () => (++audits === 1 ? MISMATCH : CLEAN),
      }),
    );
    const upd = emitted.find((e) => e.event === "plugin.checkout.updated");
    expect(upd.detail.deps_relinked).toEqual(["/repo"]);
    expect(emitted.some((e) => e.event === "plugin.checkout.deps_relink_failed")).toBe(false);
  });

  // ── the post-force re-audit must be CONCLUSIVE before it may claim repair ──
  //
  // A re-audit that throws, or one whose entries come back per-entry
  // inconclusive, carries an EMPTY `mismatched` — byte-identical to a genuinely
  // repaired tree. Reading that emptiness as success is a check-that-cannot-fail
  // sitting inside the fix for a check-that-cannot-fail: the refresh would
  // announce a known mismatch repaired with no positive evidence, and emit no
  // doubt at all. Mutating the guard back to `else { depsRelinked.push(...) }`
  // fails both tests below.

  test("a post-force re-audit that THROWS claims no relink and says so, loudly", () => {
    const emitted = [];
    let audits = 0;
    refreshPluginCheckout(
      baseArgs({
        gitFn: makeAuditGitFn(),
        emitFn: (e) => emitted.push(e),
        bunInstallFn: () => {},
        auditFn: () => {
          audits += 1;
          if (audits === 1) return MISMATCH;
          throw new Error("package manifest momentarily unreadable");
        },
      }),
    );
    expect(emitted.find((e) => e.event === "plugin.checkout.updated").detail.deps_relinked).toEqual([]);
    const ev = emitted.find(
      (e) => e.event === "plugin.checkout.deps_audit_inconclusive" && e.detail.forced === true,
    );
    expect(ev).toBeDefined();
    expect(ev.severity).toBe("WARN");
    expect(ev.detail.reason).toContain("package manifest momentarily unreadable");
    // Not silently reclassified as a relink FAILURE either — we do not know that.
    expect(emitted.some((e) => e.event === "plugin.checkout.deps_relink_failed")).toBe(false);
  });

  test("a post-force re-audit with PER-ENTRY inconclusives claims no relink", () => {
    // conclusive:true and mismatched:[] — the shape that looks cleanest of all,
    // and still proves nothing: no importer could be read for the entry.
    const emitted = [];
    let audits = 0;
    refreshPluginCheckout(
      baseArgs({
        gitFn: makeAuditGitFn(),
        emitFn: (e) => emitted.push(e),
        bunInstallFn: () => {},
        auditFn: () =>
          ++audits === 1
            ? MISMATCH
            : {
                conclusive: true,
                reason: null,
                checked: 1,
                matched: [],
                mismatched: [],
                inconclusive: [
                  {
                    key: "@catalyst-cloud/schema",
                    id: "@catalyst-cloud/schema",
                    to: "0.1.5",
                    reason: "no importer on disk resolves @catalyst-cloud/schema",
                  },
                ],
              },
      }),
    );
    expect(emitted.find((e) => e.event === "plugin.checkout.updated").detail.deps_relinked).toEqual([]);
    const ev = emitted.find(
      (e) => e.event === "plugin.checkout.deps_audit_inconclusive" && e.detail.forced === true,
    );
    expect(ev).toBeDefined();
    expect(ev.detail.inconclusive[0].id).toBe("@catalyst-cloud/schema");
  });

  test("the detection-pass and post-force inconclusives are distinguishable by `forced`", () => {
    // Both emit the same event name; an operator (and any alert) has to be able
    // to tell "could not look BEFORE remediating" from "could not confirm the
    // remediation". Dropping either `forced` literal fails this.
    const emitted = [];
    refreshPluginCheckout(
      baseArgs({
        gitFn: makeAuditGitFn(),
        emitFn: (e) => emitted.push(e),
        bunInstallFn: () => {},
        auditFn: () => ({
          conclusive: false,
          reason: "previous lockfile unavailable",
          checked: 0,
          matched: [],
          mismatched: [],
          inconclusive: [],
        }),
      }),
    );
    const ev = emitted.find((e) => e.event === "plugin.checkout.deps_audit_inconclusive");
    expect(ev.detail.forced).toBe(false);
  });

  test("a force that does NOT fix it emits deps_relink_failed (ERROR) and claims no relink", () => {
    const emitted = [];
    refreshPluginCheckout(
      baseArgs({
        gitFn: makeAuditGitFn(),
        emitFn: (e) => emitted.push(e),
        bunInstallFn: () => {},
        auditFn: () => MISMATCH, // still mismatched after the force
      }),
    );
    const fail = emitted.find((e) => e.event === "plugin.checkout.deps_relink_failed");
    expect(fail).toBeDefined();
    expect(fail.severity).toBe("ERROR");
    expect(emitted.find((e) => e.event === "plugin.checkout.updated").detail.deps_relinked).toEqual([]);
  });

  test("a THROWING forced install surfaces deps_install_failed(forced) and never crashes the refresh", () => {
    const emitted = [];
    let installs = 0;
    const res = refreshPluginCheckout(
      baseArgs({
        gitFn: makeAuditGitFn(),
        emitFn: (e) => emitted.push(e),
        bunInstallFn: () => {
          installs += 1;
          if (installs === 2) throw new Error("bun install --force exploded");
        },
        auditFn: () => MISMATCH,
      }),
    );
    const fail = emitted.find(
      (e) => e.event === "plugin.checkout.deps_install_failed" && e.detail.forced === true,
    );
    expect(fail).toBeDefined();
    expect(emitted.some((e) => e.event === "plugin.checkout.deps_relink_failed")).toBe(false);
    expect(res.changed).toBe(true);
  });

  test("an INCONCLUSIVE audit is surfaced and does NOT force — 'could not look' is not 'stale'", () => {
    const installs = [];
    const emitted = [];
    refreshPluginCheckout(
      baseArgs({
        gitFn: makeAuditGitFn(),
        emitFn: (e) => emitted.push(e),
        bunInstallFn: (dir, opts) => installs.push({ dir, opts }),
        auditFn: () => ({
          conclusive: false,
          reason: "previous lockfile unavailable",
          checked: 0,
          matched: [],
          mismatched: [],
          inconclusive: [],
        }),
      }),
    );
    const ev = emitted.find((e) => e.event === "plugin.checkout.deps_audit_inconclusive");
    expect(ev).toBeDefined();
    expect(ev.severity).toBe("WARN");
    expect(ev.detail.reason).toBe("previous lockfile unavailable");
    expect(installs).toHaveLength(1);
  });

  test("a per-entry inconclusive verdict is surfaced too, even on a conclusive audit", () => {
    const emitted = [];
    refreshPluginCheckout(
      baseArgs({
        gitFn: makeAuditGitFn(),
        emitFn: (e) => emitted.push(e),
        bunInstallFn: () => {},
        auditFn: () => ({
          conclusive: true,
          reason: null,
          checked: 1,
          matched: [],
          mismatched: [],
          inconclusive: [{ key: "x", id: "x", to: "1.0.0", reason: "no importer on disk resolves x" }],
        }),
      }),
    );
    const ev = emitted.find((e) => e.event === "plugin.checkout.deps_audit_inconclusive");
    expect(ev).toBeDefined();
    expect(ev.detail.inconclusive[0].id).toBe("x");
  });

  test("a THROWING audit degrades to inconclusive — the guardrail cannot take down the refresh", () => {
    const emitted = [];
    const installs = [];
    const res = refreshPluginCheckout(
      baseArgs({
        gitFn: makeAuditGitFn(),
        emitFn: (e) => emitted.push(e),
        bunInstallFn: (dir, opts) => installs.push({ dir, opts }),
        auditFn: () => {
          throw new Error("resolver blew up");
        },
      }),
    );
    const ev = emitted.find((e) => e.event === "plugin.checkout.deps_audit_inconclusive");
    expect(ev).toBeDefined();
    expect(ev.detail.reason).toContain("resolver blew up");
    expect(installs).toHaveLength(1);
    expect(res.changed).toBe(true);
  });

  test("the pre-pull lockfile is read with `git show <oldSha>:<rel>`", () => {
    const gitFn = makeAuditGitFn({ diffOutput: "plugins/dev/scripts/orch-monitor/ui/bun.lock\n" });
    let seen = null;
    refreshPluginCheckout(
      baseArgs({
        gitFn,
        bunInstallFn: () => {},
        auditFn: (a) => {
          seen = a;
          return CLEAN;
        },
      }),
    );
    expect(
      gitFn.calls.some(
        (c) =>
          c.args[0] === "show" && c.args[1] === "oldsha:plugins/dev/scripts/orch-monitor/ui/bun.lock",
      ),
    ).toBe(true);
    expect(seen.oldLockText).toBe(OLD_LOCK);
    expect(seen.newLockText).toBe(NEW_LOCK);
  });

  test("no bun.lock in the diff → the audit never runs (package.json-only change)", () => {
    let audits = 0;
    const installs = [];
    refreshPluginCheckout(
      baseArgs({
        gitFn: makeAuditGitFn({ diffOutput: "plugins/dev/scripts/orch-monitor/ui/package.json\n" }),
        bunInstallFn: (dir, opts) => installs.push({ dir, opts }),
        auditFn: () => {
          audits += 1;
          return MISMATCH;
        },
      }),
    );
    expect(audits).toBe(0);
    expect(installs).toHaveLength(1);
  });

  test("an install that FAILED is never audited or forced — the tree was never built", () => {
    let audits = 0;
    const emitted = [];
    refreshPluginCheckout(
      baseArgs({
        gitFn: makeAuditGitFn(),
        emitFn: (e) => emitted.push(e),
        bunInstallFn: () => {
          throw new Error("frozen lockfile rejected");
        },
        auditFn: () => {
          audits += 1;
          return MISMATCH;
        },
      }),
    );
    expect(audits).toBe(0);
    expect(emitted.some((e) => e.event === "plugin.checkout.deps_install_failed")).toBe(true);
    expect(emitted.some((e) => e.event === "plugin.checkout.deps_install_noop")).toBe(false);
  });
});
