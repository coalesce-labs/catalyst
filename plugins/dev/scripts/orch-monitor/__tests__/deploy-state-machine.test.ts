import { describe, it, expect } from "bun:test";
import {
  nextDeployState,
  type DeployStateInputs,
} from "../lib/deploy-state-machine";
import { DEPLOY_DEFAULTS } from "../lib/deploy-config";

const PROD_ENV = DEPLOY_DEFAULTS.productionEnvironment;

function makeInputs(over: Partial<DeployStateInputs> = {}): DeployStateInputs {
  return {
    nowMs: Date.parse("2026-05-04T00:30:00Z"),
    currentStatus: "merging",
    mergeCommitSha: "abc123",
    productionEnvironment: PROD_ENV,
    timeoutSec: 1800,
    skipDeployVerification: false,
    deployStartedAtMs: null,
    failedAttempts: 0,
    maxAttempts: 3,
    event: null,
    ...over,
  };
}

describe("nextDeployState — terminal/no-op cases", () => {
  it("returns no patch when status is already terminal (done)", () => {
    const out = nextDeployState(makeInputs({ currentStatus: "done" }));
    expect(out.patch).toEqual({});
    expect(out.attention).toBeNull();
  });

  it("returns no patch when status is failed", () => {
    const out = nextDeployState(makeInputs({ currentStatus: "failed" }));
    expect(out.patch).toEqual({});
  });

  it("returns no patch when no event arrives and we are below the timeout window", () => {
    const out = nextDeployState(makeInputs({ event: null, currentStatus: "merged" }));
    expect(out.patch).toEqual({});
  });
});

describe("nextDeployState — MERGED handling", () => {
  it("on MERGED with skipDeployVerification: true → status: done immediately (CTL-133 shortcut)", () => {
    const out = nextDeployState(
      makeInputs({
        currentStatus: "merging",
        skipDeployVerification: true,
        event: { type: "github.pr.merged", environment: null, state: null, sha: "abc123" },
      }),
    );
    expect(out.patch.status).toBe("done");
  });

  it("on MERGED with skipDeployVerification: false → status: merged (waiting for deploy)", () => {
    const out = nextDeployState(
      makeInputs({
        currentStatus: "merging",
        skipDeployVerification: false,
        event: { type: "github.pr.merged", environment: null, state: null, sha: "abc123" },
      }),
    );
    expect(out.patch.status).toBe("merged");
    // Capture the deployment start clock for later timeout detection.
    expect(out.patch.deployStartedAtMs).toBeDefined();
  });
});

describe("nextDeployState — deployment_status events", () => {
  it("on github.deployment.created for production env → status: deploying", () => {
    const out = nextDeployState(
      makeInputs({
        currentStatus: "merged",
        event: {
          type: "github.deployment.created",
          environment: PROD_ENV,
          state: null,
          sha: "abc123",
        },
      }),
    );
    expect(out.patch.status).toBe("deploying");
  });

  it("ignores github.deployment.created for non-production environments", () => {
    const out = nextDeployState(
      makeInputs({
        currentStatus: "merged",
        event: {
          type: "github.deployment.created",
          environment: "staging",
          state: null,
          sha: "abc123",
        },
      }),
    );
    expect(out.patch.status).toBeUndefined();
  });

  it("ignores github.deployment.created when SHA does not match merge SHA", () => {
    const out = nextDeployState(
      makeInputs({
        currentStatus: "merged",
        mergeCommitSha: "abc123",
        event: {
          type: "github.deployment.created",
          environment: PROD_ENV,
          state: null,
          sha: "different-sha",
        },
      }),
    );
    expect(out.patch.status).toBeUndefined();
  });

  it("on deployment_status.success for production → status: done", () => {
    const out = nextDeployState(
      makeInputs({
        currentStatus: "deploying",
        event: {
          type: "github.deployment_status",
          environment: PROD_ENV,
          state: "success",
          sha: "abc123",
        },
      }),
    );
    expect(out.patch.status).toBe("done");
  });

  it("on deployment_status.failure for production → status: deploy-failed", () => {
    const out = nextDeployState(
      makeInputs({
        currentStatus: "deploying",
        event: {
          type: "github.deployment_status",
          environment: PROD_ENV,
          state: "failure",
          sha: "abc123",
        },
      }),
    );
    expect(out.patch.status).toBe("deploy-failed");
    expect(out.attention).not.toBeNull();
  });

  it("on deployment_status.error for production → status: deploy-failed (treated same as failure)", () => {
    const out = nextDeployState(
      makeInputs({
        currentStatus: "deploying",
        event: {
          type: "github.deployment_status",
          environment: PROD_ENV,
          state: "error",
          sha: "abc123",
        },
      }),
    );
    expect(out.patch.status).toBe("deploy-failed");
  });

  it("ignores deployment_status events from non-production environments", () => {
    const out = nextDeployState(
      makeInputs({
        currentStatus: "deploying",
        event: {
          type: "github.deployment_status",
          environment: "staging",
          state: "failure",
          sha: "abc123",
        },
      }),
    );
    expect(out.patch.status).toBeUndefined();
  });
});

describe("nextDeployState — timeout handling", () => {
  it("escalates with attention + status: stalled when timeoutSec elapses with no resolution", () => {
    const start = Date.parse("2026-05-04T00:00:00Z");
    const out = nextDeployState(
      makeInputs({
        currentStatus: "merged",
        deployStartedAtMs: start,
        nowMs: start + 1801 * 1000, // just past 1800s timeout
        timeoutSec: 1800,
        event: null,
      }),
    );
    expect(out.patch.status).toBe("stalled");
    expect(out.attention).toContain("deploy");
  });

  it("does not escalate when timeoutSec has not yet elapsed", () => {
    const start = Date.parse("2026-05-04T00:00:00Z");
    const out = nextDeployState(
      makeInputs({
        currentStatus: "merged",
        deployStartedAtMs: start,
        nowMs: start + 100 * 1000,
        timeoutSec: 1800,
        event: null,
      }),
    );
    expect(out.patch.status).toBeUndefined();
    expect(out.attention).toBeNull();
  });
});

describe("nextDeployState — retry budget", () => {
  it("does not escalate to stalled until failedAttempts >= maxAttempts", () => {
    // First failure → deploy-failed but recoverable
    const out1 = nextDeployState(
      makeInputs({
        currentStatus: "deploying",
        failedAttempts: 0,
        maxAttempts: 3,
        event: {
          type: "github.deployment_status",
          environment: PROD_ENV,
          state: "failure",
          sha: "abc123",
        },
      }),
    );
    expect(out1.patch.status).toBe("deploy-failed");
    expect(out1.patch.failedAttempts).toBe(1);

    // After 3 failures, budget exhausted: status sticks at deploy-failed but
    // attention escalates to a budget-exhausted message.
    const out2 = nextDeployState(
      makeInputs({
        currentStatus: "deploying",
        failedAttempts: 2,
        maxAttempts: 3,
        event: {
          type: "github.deployment_status",
          environment: PROD_ENV,
          state: "failure",
          sha: "abc123",
        },
      }),
    );
    expect(out2.patch.failedAttempts).toBe(3);
    expect(out2.attention).toContain("budget");
  });
});
