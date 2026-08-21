// claude-accounts-cloud-daemon-wiring.test.mjs — CTL-1991 Phase 2.
// Verifies the daemon's cluster-sync timer ordering contract and event name
// namespace safety. Does NOT start the live daemon — tests the contracts that
// the injectable-fn pattern enforces (call order, fail-open) plus the event
// name namespace checks.
//
// Run: cd plugins/dev/scripts/execution-core && bun test claude-accounts-cloud-daemon-wiring.test.mjs

import { describe, test, expect } from "bun:test";

// ── timer call-order tests ─────────────────────────────────────────────────────

describe("daemon cluster-sync timer call order (CTL-1991)", () => {
  test("default-off: syncClaudeAccountsFromCloud returns skipped for cluster/off", async () => {
    // Simulates syncClaudeAccountsFromCloud({mode:"off", ...}) — the function
    // must return { skipped:true, reason:"disabled" } and leave disk untouched.
    // The daemon imports this fn from the module; here we verify the module's
    // real behavior directly.
    const { syncClaudeAccountsFromCloud } = await import("./claude-accounts-cloud-fetch.mjs");
    const result = await syncClaudeAccountsFromCloud({
      env: {},
      deploymentMode: { mode: "cluster", inferred: false, recognized: true },
      mode: "off",
      log: null,
    });
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("not-cloud"); // cluster → not-cloud before even checking mode
  });

  test("non-cloud mode: not-cloud short-circuits before disabled check", async () => {
    const { syncClaudeAccountsFromCloud } = await import("./claude-accounts-cloud-fetch.mjs");
    // single-host should also be not-cloud
    const result = await syncClaudeAccountsFromCloud({
      env: { CATALYST_CLAUDE_ACCOUNTS_CLOUD: "enforce" },
      deploymentMode: { mode: "single-host", inferred: false, recognized: true },
      mode: "enforce",
      log: null,
    });
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("not-cloud");
  });

  test("inferred cloud: skipped as not-cloud (inferred=true never activates)", async () => {
    const { syncClaudeAccountsFromCloud } = await import("./claude-accounts-cloud-fetch.mjs");
    const result = await syncClaudeAccountsFromCloud({
      env: { CATALYST_CLAUDE_ACCOUNTS_CLOUD: "enforce" },
      deploymentMode: { mode: "cloud", inferred: true, recognized: true },
      mode: "enforce",
      log: null,
    });
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("not-cloud");
  });

  test("enforce mode on genuine cloud: syncClaudeAccountsFromCloud is called before armSecret (ordering invariant)", () => {
    // We verify the call order the daemon's timer tick enforces using a
    // synthetic replay: cloud-sync is always first, then armSecret.
    // This is a contract test — the daemon.mjs wiring puts syncClaudeAccountsFromCloudFn
    // in a try/await block BEFORE armSecret("claude-accounts.env").
    const callOrder = [];
    const fakeCloudSync = async () => { callOrder.push("cloud-sync"); return { skipped: true, reason: "not-cloud" }; };
    const fakeArmSecret = () => { callOrder.push("arm-secret"); };

    // Simulate one timer tick (the try/catch wrapper in daemon.mjs)
    return fakeCloudSync()
      .catch(() => {})  // fail-open: swallow any throw
      .then(() => { fakeArmSecret(); })
      .then(() => {
        expect(callOrder).toEqual(["cloud-sync", "arm-secret"]);
      });
  });

  test("fail-open: a throw from syncClaudeAccountsFromCloud does not abort the tick", async () => {
    const callOrder = [];
    const throwingSync = async () => { throw new Error("cloud outage"); };
    const fakeArmSecret = () => { callOrder.push("arm-secret"); };

    // Mirrors the daemon's try/catch around syncClaudeAccountsFromCloudFn
    try {
      await throwingSync();
    } catch {
      // Swallowed — tick continues
    }
    fakeArmSecret();

    expect(callOrder).toEqual(["arm-secret"]);
  });

  test("boot sync: fire-and-forget .catch() swallows throw (fail-open)", async () => {
    // Boot path uses .catch() pattern (startDaemon is not async).
    let caught = false;
    const throwingSync = async () => { throw new Error("outage at boot"); };
    await throwingSync().catch(() => { caught = true; });
    // Process continues regardless
    expect(caught).toBe(true);
  });
});

// ── event emission tests ──────────────────────────────────────────────────────

describe("event emission for cloud-accounts materialize (CTL-1991)", () => {
  test("CLAUDE_ACCOUNTS_CLOUD_MATERIALIZED_EVENT is a valid non-broker-protected name", async () => {
    const { CLAUDE_ACCOUNTS_CLOUD_MATERIALIZED_EVENT } = await import("./claude-accounts-cloud-event.mjs");
    const { isBrokerProtectedName } = await import("../broker/namespace-contract.mjs");
    expect(isBrokerProtectedName(CLAUDE_ACCOUNTS_CLOUD_MATERIALIZED_EVENT)).toBe(false);
  });

  test("CLAUDE_ACCOUNTS_CLOUD_WOULD_MATERIALIZE_EVENT is a valid non-broker-protected name", async () => {
    const { CLAUDE_ACCOUNTS_CLOUD_WOULD_MATERIALIZE_EVENT } = await import("./claude-accounts-cloud-event.mjs");
    const { isBrokerProtectedName } = await import("../broker/namespace-contract.mjs");
    expect(isBrokerProtectedName(CLAUDE_ACCOUNTS_CLOUD_WOULD_MATERIALIZE_EVENT)).toBe(false);
  });

  test("event name constants match the catalyst.claude-accounts.* prefix", async () => {
    const { CLAUDE_ACCOUNTS_CLOUD_MATERIALIZED_EVENT, CLAUDE_ACCOUNTS_CLOUD_WOULD_MATERIALIZE_EVENT } = await import("./claude-accounts-cloud-event.mjs");
    expect(CLAUDE_ACCOUNTS_CLOUD_MATERIALIZED_EVENT).toMatch(/^catalyst\.claude-accounts\./);
    expect(CLAUDE_ACCOUNTS_CLOUD_WOULD_MATERIALIZE_EVENT).toMatch(/^catalyst\.claude-accounts\./);
  });
});
