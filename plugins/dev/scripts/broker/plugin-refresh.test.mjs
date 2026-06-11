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

describe("refreshPluginCheckout", () => {
  beforeEach(() => __clearThrottleForTest());

  function makeGitFn({ before = "aaaa", after = "bbbb", pullThrows = false } = {}) {
    const calls = [];
    const gitFn = (root, args) => {
      calls.push({ root, args });
      const sub = args[0];
      if (sub === "rev-parse") {
        // first rev-parse → before, subsequent → after (the pull advanced HEAD)
        const seen = calls.filter((c) => c.args[0] === "rev-parse").length;
        return seen === 1 ? before : after;
      }
      if (sub === "pull") {
        if (pullThrows) {
          const e = new Error("not fast-forwardable");
          throw e;
        }
        return "";
      }
      return "";
    };
    gitFn.calls = calls;
    return gitFn;
  }

  test("runs ff-only pull and emits plugin.checkout.updated with old+new sha", () => {
    const emitted = [];
    const gitFn = makeGitFn({ before: "old111", after: "new222" });
    const res = refreshPluginCheckout({
      root: "/co",
      now: 1_000_000,
      gitFn,
      emitFn: (e) => emitted.push(e),
    });

    expect(res.pulled).toBe(true);
    // an ff-only pull was issued against the right checkout
    const pull = gitFn.calls.find((c) => c.args[0] === "pull");
    expect(pull.root).toBe("/co");
    expect(pull.args).toContain("--ff-only");

    expect(emitted).toHaveLength(1);
    expect(emitted[0].event).toBe("plugin.checkout.updated");
    expect(emitted[0].detail.checkout).toBe("/co");
    expect(emitted[0].detail.old_sha).toBe("old111");
    expect(emitted[0].detail.new_sha).toBe("new222");
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

    const pulls = gitFn.calls.filter((c) => c.args[0] === "pull");
    expect(pulls).toHaveLength(2);
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

  test("ff-only pull failure surfaces as a refresh_failed event (not silent)", () => {
    const emitted = [];
    const gitFn = makeGitFn({ pullThrows: true });
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
        if (args[0] === "pull") {
          pulled = true;
          return "";
        }
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
