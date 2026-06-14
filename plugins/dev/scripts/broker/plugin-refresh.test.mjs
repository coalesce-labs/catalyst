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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolvePluginCheckoutRoots,
  resolveRepoFullName,
  isThisRepoMergeEvent,
  refreshPluginCheckout,
  handlePluginRefreshEvent,
  PLUGIN_REFRESH_THROTTLE_MS,
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
