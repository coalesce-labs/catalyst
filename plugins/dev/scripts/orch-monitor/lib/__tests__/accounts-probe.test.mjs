import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deriveAccountsSummary,
  createAccountsProbe,
  defaultAccountsProbeExec,
  resolveRuntime,
} from "../accounts-probe.mjs";

const REJECTED_ACTIVE = {
  generatedAt: "2026-08-05T12:00:00.000Z",
  accounts: [
    {
      label: "acctA",
      isActive: true,
      email: "a@x.io",
      overallStatus: "rejected",
      representativeClaim: "seven_day",
      fiveHour: { pct: 40, resetsAt: "2026-08-05T13:00:00.000Z", status: "allowed" },
      sevenDay: { pct: 100, resetsAt: "2026-08-06T00:00:00.000Z", status: "rejected" },
      error: null,
    },
    {
      label: "acctB",
      isActive: false,
      email: "b@x.io",
      overallStatus: "allowed",
      representativeClaim: "five_hour",
      fiveHour: { pct: 10, resetsAt: "2026-08-05T13:00:00.000Z", status: "allowed" },
      sevenDay: { pct: 20, resetsAt: "2026-08-12T00:00:00.000Z", status: "allowed" },
      error: null,
    },
  ],
};

describe("deriveAccountsSummary", () => {
  it("keys the node, picks the active account, and its binding-window status", () => {
    const s = deriveAccountsSummary(REJECTED_ACTIVE, { node: "mini-2" });
    expect(s.node).toBe("mini-2");
    expect(s.active.label).toBe("acctA");
    expect(s.active.bindingWindow).toBe("seven_day"); // == representativeClaim
    expect(s.active.bindingStatus).toBe("rejected"); // sevenDay.status
    expect(s.status).toBe("rejected"); // node-level == active binding status
  });
  it("names a sibling with headroom (allowed, not active) when the active is rejected", () => {
    const s = deriveAccountsSummary(REJECTED_ACTIVE, { node: "mini-2" });
    expect(s.siblingWithHeadroom).toEqual({ label: "acctB", email: "b@x.io" });
  });
  it("returns siblingWithHeadroom=null when no non-active account is allowed", () => {
    const only = { ...REJECTED_ACTIVE, accounts: [REJECTED_ACTIVE.accounts[0]] };
    expect(deriveAccountsSummary(only, { node: "n" }).siblingWithHeadroom).toBeNull();
  });
  it("distinguishes a transport error from rejected (status='error', not loud)", () => {
    const errd = {
      generatedAt: "t",
      accounts: [
        {
          label: "acctA",
          isActive: true,
          email: "a@x.io",
          overallStatus: null,
          representativeClaim: null,
          fiveHour: null,
          sevenDay: null,
          error: "network error",
        },
      ],
    };
    const s = deriveAccountsSummary(errd, { node: "n" });
    expect(s.status).toBe("error");
    expect(s.active.error).toBe("network error");
  });
  it("status='unknown' when no account is active (CLAUDE_CODE_OAUTH_TOKEN unset)", () => {
    const none = { generatedAt: "t", accounts: [{ ...REJECTED_ACTIVE.accounts[1] }] };
    expect(deriveAccountsSummary(none, { node: "n" }).status).toBe("unknown");
  });
  it("NEVER surfaces a token field even if one leaks into the raw record", () => {
    const tainted = structuredClone(REJECTED_ACTIVE);
    tainted.accounts[0].token = "sk-ant-oat-LEAK";
    const s = deriveAccountsSummary(tainted, { node: "n" });
    expect(JSON.stringify(s)).not.toContain("sk-ant-oat");
    expect(JSON.stringify(s)).not.toContain("token");
  });
  it("raw.available===false short-circuits to the SAME minimal shape as the disabled path", () => {
    const s = deriveAccountsSummary(
      { generatedAt: "t", accounts: [], available: false },
      { node: "mini-2" },
    );
    expect(s).toEqual({ node: "mini-2", available: false });
  });
});

describe("createAccountsProbe (cache)", () => {
  const mkExec = () => {
    // injected fake, counts invocations
    let n = 0;
    const exec = async () => {
      n += 1;
      return { ...REJECTED_ACTIVE, _n: n };
    };
    return { exec, calls: () => n };
  };
  it("probes once, then serves cache within TTL (no second probe)", async () => {
    const { exec, calls } = mkExec();
    let t = 1000;
    const p = createAccountsProbe({ exec, ttlMs: 5000, now: () => t, node: "n" });
    const a = await p.get();
    t = 2000;
    const b = await p.get();
    expect(calls()).toBe(1);
    expect(b.probedAt).toBe(a.probedAt);
    expect(b.cached).toBe(true);
  });
  it("re-probes after TTL expiry", async () => {
    const { exec, calls } = mkExec();
    let t = 1000;
    const p = createAccountsProbe({ exec, ttlMs: 5000, now: () => t, node: "n" });
    await p.get();
    t = 7000;
    await p.get();
    expect(calls()).toBe(2);
  });
  it("refresh:true bypasses a fresh cache (refreshFloorMs:0)", async () => {
    const { exec, calls } = mkExec();
    const p = createAccountsProbe({
      exec,
      ttlMs: 5000,
      refreshFloorMs: 0,
      now: () => 1000,
      node: "n",
    });
    await p.get();
    await p.get({ refresh: true });
    expect(calls()).toBe(2);
  });
  it("refresh WITHIN the floor serves cache (no probe) — DoS guard", async () => {
    const { exec, calls } = mkExec();
    let t = 1000;
    const p = createAccountsProbe({
      exec,
      ttlMs: 5000,
      refreshFloorMs: 2000,
      now: () => t,
      node: "n",
    });
    await p.get(); // probes, cache at t=1000
    t = 2500; // within the 2000ms floor
    const b = await p.get({ refresh: true });
    expect(calls()).toBe(1); // refresh throttled by the floor
    expect(b.cached).toBe(true);
  });
  it("refresh AFTER the floor re-probes", async () => {
    const { exec, calls } = mkExec();
    let t = 1000;
    const p = createAccountsProbe({
      exec,
      ttlMs: 5000,
      refreshFloorMs: 2000,
      now: () => t,
      node: "n",
    });
    await p.get();
    t = 3500; // past the 2000ms floor
    await p.get({ refresh: true });
    expect(calls()).toBe(2);
  });
  it("coalesces concurrent get() calls into a single probe (DoS guard)", async () => {
    let n = 0;
    const exec = async () => {
      n += 1;
      await Promise.resolve(); // yield so all three callers overlap
      return REJECTED_ACTIVE;
    };
    const p = createAccountsProbe({ exec, ttlMs: 5000, now: () => 1000, node: "n" });
    await Promise.all([p.get(), p.get(), p.get()]);
    expect(n).toBe(1);
  });
  it("latest() returns the last posture without probing; null before first probe", async () => {
    const { exec, calls } = mkExec();
    const p = createAccountsProbe({ exec, ttlMs: 5000, now: () => 1000, node: "n" });
    expect(p.latest()).toBeNull();
    await p.get();
    expect(p.latest()).not.toBeNull();
    expect(calls()).toBe(1);
  });
  it("a throwing exec yields an error posture, never throws, and retries after the floor", async () => {
    let n = 0;
    let t = 1000;
    const exec = async () => {
      n += 1;
      throw new Error("spawn EACCES");
    };
    const p = createAccountsProbe({ exec, ttlMs: 5000, refreshFloorMs: 2000, now: () => t, node: "n" });
    const r = await p.get();
    expect(r.status).toBe("error");
    t = 3000; // within ttl but past the refresh floor
    const throttled = await p.get(); // normal read within ttl cadence → served, not re-probed
    expect(n).toBe(1);
    expect(throttled.status).toBe("error");
    t = 7000; // past the ttl
    await p.get(); // retries, not a stale error served forever
    expect(n).toBe(2);
  });
  it("a forced ?refresh during SUSTAINED failure cannot re-probe faster than the floor (DoS cold-hole)", async () => {
    // low-severity DoS finding (CTL-1653): errors are uncached, so pre-fix every
    // serialized refresh=true during a failing probe spawned a fresh subprocess +
    // Haiku call. The floor now gates probe INITIATION, not just cache hits.
    let n = 0;
    let t = 1000;
    const exec = async () => {
      n += 1;
      throw new Error("401 unauthorized");
    };
    const p = createAccountsProbe({ exec, ttlMs: 5000, refreshFloorMs: 2000, now: () => t, node: "n" });
    const first = await p.get({ refresh: true }); // cold start → probes once
    expect(n).toBe(1);
    expect(first.status).toBe("error");
    t = 1500; // within the floor, still no cache (error uncached)
    const throttled = await p.get({ refresh: true });
    expect(n).toBe(1); // NOT re-probed — served the recent error posture
    expect(throttled.status).toBe("error");
    expect(throttled.cached).toBe(true);
    t = 3500; // past the floor → one retry allowed
    await p.get({ refresh: true });
    expect(n).toBe(2);
  });
});

describe("defaultAccountsProbeExec (secrets hygiene)", () => {
  it("returns an empty {accounts:[], available:false} record when the env file is absent (no probe spawned)", async () => {
    const missing = join(tmpdir(), "definitely-absent-accounts-env-" + process.pid + ".env");
    const r = await defaultAccountsProbeExec({ envFile: missing });
    expect(r.accounts).toEqual([]);
    expect(typeof r.generatedAt).toBe("string");
    expect(r.available).toBe(false);
  });
  it("preserves the probe's stdout JSON when it exits nonzero (e.g. all accounts invalid)", async () => {
    // CTL-1653 Codex finding: a nonzero exit still writes the token-free record
    // to stdout first; execFileP rejects on nonzero, so the fix must recover
    // stdout from the rejection rather than discard it in favor of a synthetic
    // unlabeled spawn-error posture.
    const dir = mkdtempSync(join(tmpdir(), "accounts-exec-nonzero-"));
    const stub = join(dir, "stub-probe.mjs");
    writeFileSync(
      stub,
      [
        "const rec = {",
        "  generatedAt: 't',",
        "  accounts: [{ label: 'acctA', isActive: true, error: 'token expired' }],",
        "};",
        "process.stdout.write(JSON.stringify(rec));",
        "process.exit(1);",
      ].join("\n"),
    );
    const envFile = join(dir, "claude-accounts.env");
    writeFileSync(envFile, 'CLAUDE_CODE_OAUTH_TOKEN="sk-ant-oat-X"\n');
    try {
      const r = await defaultAccountsProbeExec({ envFile, probePath: stub });
      expect(r.accounts[0].label).toBe("acctA");
      expect(r.accounts[0].error).toBe("token expired");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("rethrows the original error when a nonzero exit produced no usable stdout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "accounts-exec-nonzero-empty-"));
    const stub = join(dir, "stub-probe.mjs");
    writeFileSync(stub, ["process.stderr.write('boom');", "process.exit(1);"].join("\n"));
    const envFile = join(dir, "claude-accounts.env");
    writeFileSync(envFile, 'CLAUDE_CODE_OAUTH_TOKEN="sk-ant-oat-X"\n');
    try {
      await expect(defaultAccountsProbeExec({ envFile, probePath: stub })).rejects.toBeTruthy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("makes the SOURCED token sole authority in the child, keeps the parent env clean, and returns token-free", async () => {
    const dir = mkdtempSync(join(tmpdir(), "accounts-exec-"));
    const stub = join(dir, "stub-probe.mjs");
    // The stub inspects its OWN (child) env and emits a token-FREE record describing
    // what it saw — never the token value. It proves: (a) the ambient token was
    // stripped, (b) the sourced token is the one present (sole authority).
    writeFileSync(
      stub,
      [
        "const tok = process.env.CLAUDE_CODE_OAUTH_TOKEN || '';",
        "const rec = {",
        "  generatedAt: 't',",
        "  accounts: [{",
        "    label: 'stub',",
        "    isActive: true,",
        "    sawSourced: tok === 'sk-ant-oat-SOURCED',", // sourced file won
        "    sawAmbient: tok === 'sk-ant-oat-AMBIENT',", // ambient must have been stripped
        "  }],",
        "};",
        "process.stdout.write(JSON.stringify(rec));", // token itself never printed
      ].join("\n"),
    );
    const envFile = join(dir, "claude-accounts.env");
    writeFileSync(envFile, 'CLAUDE_CODE_OAUTH_TOKEN="sk-ant-oat-SOURCED"\n');

    // Ambient token in THIS process's env — the strip must remove it from the child so
    // the sourced file is the sole authority; and it must remain in the parent unchanged.
    const prior = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat-AMBIENT";
    try {
      const r = await defaultAccountsProbeExec({ envFile, probePath: stub });
      expect(JSON.stringify(r)).not.toContain("sk-ant-oat"); // token-free wire output
      expect(r.accounts[0].sawAmbient).toBe(false); // ambient stripped from child
      expect(r.accounts[0].sawSourced).toBe(true); // sourced file is sole authority
      expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat-AMBIENT"); // parent untouched
    } finally {
      if (prior === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = prior;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveRuntime (CTL-1653 Codex round-2: never the bare 'bun' command name)", () => {
  it("prefers this process's own Bun executable (process.execPath) when running under bun", () => {
    // The round-1 fix detected bun's PRESENCE correctly but still returned the
    // literal string "bun" — a launchd/mise-managed monitor launched via an
    // absolute Bun path on a restricted PATH has no `bun` command to resolve,
    // so the bare name exits command-not-found in the probe's bash -c child.
    expect(
      resolveRuntime({ isBun: true, execPath: "/opt/homebrew/opt/bun/bin/bun" }),
    ).toBe("/opt/homebrew/opt/bun/bin/bun");
  });
  it("falls back to an ABSOLUTE PATH-resolved bun (not a bare name) when not running under bun", () => {
    expect(
      resolveRuntime({
        isBun: false,
        resolveOnPath: (bin) => (bin === "bun" ? "/usr/local/bin/bun" : null),
      }),
    ).toBe("/usr/local/bin/bun");
  });
  it("falls back to the historical ~/.bun/bin/bun default-install path", () => {
    expect(
      resolveRuntime({
        isBun: false,
        resolveOnPath: () => null,
        bunHomeExists: true,
        bunHomeDefault: "/Users/x/.bun/bin/bun",
      }),
    ).toBe("/Users/x/.bun/bin/bun");
  });
  it("falls back to node (bare name, last resort) when bun is nowhere to be found", () => {
    expect(
      resolveRuntime({ isBun: false, resolveOnPath: () => null, bunHomeExists: false }),
    ).toBe("node");
  });
  it("module default resolves to a real string given the actual test host (sanity)", () => {
    // No overrides: exercises the real typeof Bun / PATH / homedir detection.
    // Under `bun test` this process IS bun, so it must be process.execPath —
    // an absolute path, never the bare literal "bun".
    const rt = resolveRuntime();
    expect(typeof rt).toBe("string");
    expect(rt).not.toBe("bun");
    expect(rt.startsWith("/")).toBe(true);
  });
});
