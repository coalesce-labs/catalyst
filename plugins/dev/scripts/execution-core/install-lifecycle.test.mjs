// install-lifecycle.test.mjs — CTL-1369 PR3. Pins the `catalyst install|uninstall|reinstall`
// lifecycle driver: the PER-CLASS step plan (the core invariant — a developer never runs the
// work stack; a worker never adopts the updater), the catalyst.install.* telemetry sequence it
// drives, backup-before-overwrite, rollback-from-backup on a failed phase, idempotency, the
// uninstall live-node guard, dry-run side-effect-freedom, and CLI exit codes. Every step shells
// out through an injected runStep stub, so nothing real is provisioned.
import { describe, test, expect, afterEach } from "bun:test";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { INSTALL_PHASES } from "./lib/install-telemetry.mjs";
import {
  UNINSTALL_PHASES,
  REINSTALL_PHASES,
  INSTALL_MANAGED_KEYS,
  resolveScripts,
  layer2Path,
  isDrainedStatus,
  resolveRequestedClass,
  resolveReadReplica,
  setDeepKey,
  deleteDeepKey,
  planPhases,
  runInstallLifecycle,
  buildDefaultDeps,
  parseArgs,
  usage,
  main,
} from "./install-lifecycle.mjs";

let tmpCounter = 0;
const tmpFiles = [];
function tmpCfg(initial) {
  const p = join(tmpdir(), `install-lifecycle-test-${process.pid}-${tmpCounter++}.json`);
  tmpFiles.push(p);
  if (initial !== undefined) writeFileSync(p, JSON.stringify(initial, null, 2));
  return p;
}
afterEach(() => {
  for (const f of tmpFiles.splice(0)) {
    try {
      rmSync(f, { force: true });
    } catch {
      /* ignore */
    }
  }
});

// Stable stub script paths so plan argv is deterministic + greppable.
const SCRIPTS = {
  pluginSrc: "PLUGIN_SRC",
  backup: "BACKUP",
  catalyst: "CATALYST",
  setup: "SETUP",
  installCli: "INSTALL_CLI",
  stack: "STACK",
};

// makeDeps — a fully-stubbed dep set. `failOn` is a predicate (argv|joined → truthy = fail with
// that rc). `bundle` is the path catalyst-backup "prints". probeDaemons/probeDrained are flags.
function makeDeps({ failOn, bundle = "/tmp/bundle-xyz", daemonsLive = false, residual = false, drained = false, bundleHadAgents = false, bundleEmpty = true, updaterAgent = false, missingBins = [], layer2Initial } = {}) {
  const events = [];
  const calls = [];
  const stepCalls = []; // {argv, env} per spawned step — lets tests assert the pinned step env
  const layer2 = tmpCfg(layer2Initial);
  let t = 0;
  const deps = {
    scripts: { ...SCRIPTS },
    env: { CATALYST_ASSUME_NO_DAEMONS: "1" },
    layer2,
    runStep: ({ argv, env }) => {
      calls.push(argv);
      stepCalls.push({ argv, env: env || {} });
      const joined = argv.join(" ");
      const rc = typeof failOn === "function" ? failOn(argv, joined) : 0;
      if (rc) return { code: rc, stdout: "", stderr: `stub fail ${joined}` };
      if (argv[0] === "BACKUP" && argv[1] === "backup") return { code: 0, stdout: `capturing…\n${bundle}\n`, stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    emit: (f) => events.push(f),
    nowFn: () => (t += 1000),
    genTraceId: () => "trace0000000000000000000000000000",
    genSpanId: () => "span000000000000",
    probeDaemons: () => daemonsLive,
    probeResidualAgents: () => residual,
    probeDrained: () => drained,
    bundleHasCapturedAgents: () => bundleHadAgents,
    bundleIsEmpty: () => bundleEmpty,
    probeUpdaterAgent: () => updaterAgent,
    scriptExists: () => true,
    binExists: (name) => !missingBins.includes(name),
    log: () => {},
    InstallRunCtor: undefined, // filled below with the real InstallRun
  };
  return { deps, events, calls, stepCalls, layer2 };
}

// The real InstallRun must drive the real telemetry contract in these tests.
import { InstallRun } from "./lib/install-telemetry.mjs";
function withRealRun(bag) {
  bag.deps.InstallRunCtor = InstallRun;
  return bag;
}

const phaseNames = (plan) => plan.map((p) => p.phase);
const stepLabels = (plan) => plan.flatMap((p) => p.steps.map((s) => s.label));
const eventNames = (events) => events.map((e) => e.event);

// ───────────────────────── parseArgs ─────────────────────────
describe("parseArgs", () => {
  test("first positional is the operation; flags parse", () => {
    const a = parseArgs(["install", "--class", "developer", "--read-replica", "http://mini:7400", "--dry-run"]);
    expect(a.operation).toBe("install");
    expect(a.class).toBe("developer");
    expect(a.readReplica).toBe("http://mini:7400");
    expect(a.dryRun).toBe(true);
  });
  test("--class= and --read-replica= equals-forms", () => {
    const a = parseArgs(["reinstall", "--class=worker", "--read-replica=http://h:7400"]);
    expect(a.class).toBe("worker");
    expect(a.readReplica).toBe("http://h:7400");
  });
  test("--print is an alias for --dry-run; --force/--json/-h flags", () => {
    expect(parseArgs(["install", "--print"]).dryRun).toBe(true);
    expect(parseArgs(["uninstall", "--force"]).force).toBe(true);
    expect(parseArgs(["install", "--json"]).json).toBe(true);
    expect(parseArgs(["-h"]).help).toBe(true);
  });
  test("unknown flags are ignored (forward-compat)", () => {
    const a = parseArgs(["install", "--future-flag", "x"]);
    expect(a.operation).toBe("install");
  });
  test("a trailing --class / --read-replica with no value is an error (not a silent fallback)", () => {
    expect(parseArgs(["install", "--class"]).errors).toContain("--class requires a value");
    expect(parseArgs(["install", "--class", "--dry-run"]).errors).toContain("--class requires a value");
    expect(parseArgs(["reinstall", "--read-replica"]).errors).toContain("--read-replica requires a value");
    expect(parseArgs(["install", "--class="]).errors).toContain("--class requires a value");
    expect(parseArgs(["install", "--class", "developer"]).errors).toHaveLength(0);
  });
});

// ───────────────────────── resolveRequestedClass ─────────────────────────
describe("resolveRequestedClass", () => {
  test("explicit --class wins and normalizes case/space", () => {
    expect(resolveRequestedClass({ optsClass: " Developer " }).nodeClass).toBe("developer");
  });
  test("explicit unrecognized class throws (the §3 footgun fix)", () => {
    expect(() => resolveRequestedClass({ optsClass: "develper" })).toThrow(/unrecognized node class/);
  });
  test("CATALYST_NODE_CLASS env is used when no --class; invalid env throws", () => {
    expect(resolveRequestedClass({ env: { CATALYST_NODE_CLASS: "worker" } }).nodeClass).toBe("worker");
    expect(() => resolveRequestedClass({ env: { CATALYST_NODE_CLASS: "nope" } })).toThrow(/unrecognized CATALYST_NODE_CLASS/);
  });
  test("falls back to the current configured class (injected currentFn)", () => {
    expect(resolveRequestedClass({ env: {}, currentFn: () => "monitor" }).nodeClass).toBe("monitor");
  });
  test("config fallback reads the class from the SELECTED layer2 file (consistent with the children, not getNodeClass)", () => {
    expect(resolveRequestedClass({ env: {}, layer2: tmpCfg({ catalyst: { node: { class: "developer" } } }) }).nodeClass).toBe("developer");
    expect(resolveRequestedClass({ env: {}, layer2: tmpCfg({}) }).nodeClass).toBe("worker"); // absent ⇒ worker
    expect(() => resolveRequestedClass({ env: {}, layer2: tmpCfg({ catalyst: { node: { class: "develper" } } }) })).toThrow(/unrecognized node class in/);
  });
  test("a MALFORMED config fails closed (does not silently default to worker)", () => {
    const bad = join(tmpdir(), `install-lifecycle-bad-${process.pid}-${tmpCounter++}.json`);
    tmpFiles.push(bad);
    writeFileSync(bad, "{ not valid json");
    expect(() => resolveRequestedClass({ env: {}, layer2: bad })).toThrow(/unreadable|malformed/);
  });
});

describe("isDrainedStatus (teardown guard requires zero in-flight, not just draining)", () => {
  test("draining with zero in-flight ⇒ drained; with in-flight ⇒ not drained", () => {
    expect(isDrainedStatus({ draining: true, inFlightCount: 0 })).toBe(true);
    expect(isDrainedStatus({ draining: true, inFlightCount: 3 })).toBe(false); // work still landing
    expect(isDrainedStatus({ draining: true })).toBe(true); // no count ⇒ treat as 0
    expect(isDrainedStatus({ drained: true, inFlightCount: 5 })).toBe(true); // explicit sentinel wins
    expect(isDrainedStatus({ draining: false })).toBe(false);
    expect(isDrainedStatus(null)).toBe(false);
  });
});

// ───────────────────────── planPhases: the per-class invariant ─────────────────────────
describe("planPhases — per-class correctness (pure)", () => {
  test("install/developer adopts the updater + drains; NEVER runs install-services", () => {
    const plan = planPhases({ operation: "install", nodeClass: "developer", scripts: SCRIPTS });
    const labels = stepLabels(plan);
    expect(labels).toContain("adopt-updater");
    expect(labels).not.toContain("install-services");
    expect(labels).toContain("drain");
    expect(labels).not.toContain("start-stack");
  });
  test("install/worker runs the full work stack; NEVER adopts the updater", () => {
    const plan = planPhases({ operation: "install", nodeClass: "worker", scripts: SCRIPTS });
    const labels = stepLabels(plan);
    expect(labels).toContain("install-services");
    expect(labels).not.toContain("adopt-updater");
    expect(labels).toContain("start-stack");
    expect(labels).not.toContain("drain");
  });
  test("install/monitor is developer-shaped (updater + drain, no work stack)", () => {
    const labels = stepLabels(planPhases({ operation: "install", nodeClass: "monitor", scripts: SCRIPTS }));
    expect(labels).toContain("adopt-updater");
    expect(labels).not.toContain("install-services");
  });
  test("install phase order EXACTLY matches the OTEL-locked INSTALL_PHASES", () => {
    expect(phaseNames(planPhases({ operation: "install", nodeClass: "worker", scripts: SCRIPTS }))).toEqual([...INSTALL_PHASES]);
  });
  test("uninstall remove-agents reaps the log-shipper (a `stop` after the plist is removed)", () => {
    const ra = planPhases({ operation: "uninstall", nodeClass: "worker", scripts: SCRIPTS }).find((p) => p.phase === "remove-agents");
    const labels = ra.steps.map((s) => s.label);
    expect(labels).toContain("reap-shipper");
    expect(labels.indexOf("uninstall-services")).toBeLessThan(labels.indexOf("reap-shipper"));
  });
  test("uninstall / reinstall phase orders match their exported enums", () => {
    expect(phaseNames(planPhases({ operation: "uninstall", nodeClass: "worker", scripts: SCRIPTS }))).toEqual([...UNINSTALL_PHASES]);
    expect(phaseNames(planPhases({ operation: "reinstall", nodeClass: "developer", scripts: SCRIPTS }))).toEqual([...REINSTALL_PHASES]);
  });
  test("reinstall backs up exactly ONCE (one top-of-run snapshot covers teardown+provision)", () => {
    const plan = planPhases({ operation: "reinstall", nodeClass: "worker", scripts: SCRIPTS });
    expect(plan.filter((p) => p.phase === "backup")).toHaveLength(1);
    expect(stepLabels(plan).filter((l) => l === "backup")).toHaveLength(1);
  });
  test("read-replica binds only for developer/monitor when supplied; never for worker", () => {
    const dev = stepLabels(planPhases({ operation: "install", nodeClass: "developer", scripts: SCRIPTS, opts: { readReplica: "http://h:7400" } }));
    expect(dev).toContain("read-replica");
    const worker = stepLabels(planPhases({ operation: "install", nodeClass: "worker", scripts: SCRIPTS, opts: { readReplica: "http://h:7400" } }));
    expect(worker).not.toContain("read-replica");
    const devNoUrl = stepLabels(planPhases({ operation: "install", nodeClass: "developer", scripts: SCRIPTS }));
    expect(devNoUrl).not.toContain("read-replica");
  });
  test("worker install resets pluginPullOwner to broker; developer/monitor never do (adopt-updater owns it)", () => {
    const wc = planPhases({ operation: "install", nodeClass: "worker", scripts: SCRIPTS }).find((p) => p.phase === "write-config");
    const po = wc.steps.find((s) => s.label === "pull-owner");
    expect(po).toMatchObject({ kind: "setkey", key: "catalyst.orchestration.pluginPullOwner", value: "broker" });
    const devWc = planPhases({ operation: "install", nodeClass: "developer", scripts: SCRIPTS }).find((p) => p.phase === "write-config");
    expect(devWc.steps.some((s) => s.label === "pull-owner")).toBe(false);
  });
  test("backup label carries operation + class", () => {
    const plan = planPhases({ operation: "install", nodeClass: "developer", scripts: SCRIPTS });
    const backupStep = plan.find((p) => p.phase === "backup").steps[0];
    expect(backupStep.argv).toEqual(["BACKUP", "backup", "--label", "install-developer"]);
  });
  test("unknown operation throws", () => {
    expect(() => planPhases({ operation: "frobnicate", nodeClass: "worker", scripts: SCRIPTS })).toThrow(/unknown operation/);
  });
});

// ───────────────────────── runInstallLifecycle: telemetry + behavior ─────────────────────────
describe("runInstallLifecycle — install happy path", () => {
  test("developer: completes, healthy, emits started→6 phases→completed, captures bundle", async () => {
    const { deps, events, calls } = withRealRun(makeDeps());
    const res = await runInstallLifecycle({ operation: "install", nodeClass: "developer", opts: {} }, deps);
    expect(res.outcome).toBe("completed");
    expect(res.healthOk).toBe(true);
    expect(res.bundlePath).toBe("/tmp/bundle-xyz");
    // event sequence
    expect(eventNames(events)[0]).toBe("catalyst.install.started");
    expect(eventNames(events).at(-1)).toBe("catalyst.install.completed");
    const phaseEvents = events.filter((e) => e.event === "catalyst.install.phase").map((e) => e.phase);
    expect(phaseEvents).toEqual([...INSTALL_PHASES]);
    // every event carries operation + node class + trace context
    for (const e of events) {
      expect(e.operation).toBe("install");
      expect(e.nodeClass).toBe("developer");
      expect(e.traceId).toBe("trace0000000000000000000000000000");
    }
    // composed the developer-correct steps
    const joined = calls.map((a) => a.join(" "));
    expect(joined).toContain("STACK adopt-updater");
    expect(joined.some((c) => c.includes("install-services"))).toBe(false);
  });

  test("worker: runs install-services + start-stack, never adopt-updater", async () => {
    const { deps, calls } = withRealRun(makeDeps());
    const res = await runInstallLifecycle({ operation: "install", nodeClass: "worker", opts: {} }, deps);
    expect(res.outcome).toBe("completed");
    const joined = calls.map((a) => a.join(" "));
    expect(joined).toContain("STACK install-services");
    expect(joined).toContain("STACK start --yes");
    expect(joined.some((c) => c.includes("adopt-updater"))).toBe(false);
  });

  test("read-replica setkey writes the Layer-2 file (developer)", async () => {
    const { deps, layer2 } = withRealRun(makeDeps());
    await runInstallLifecycle({ operation: "install", nodeClass: "developer", opts: { readReplica: "http://mini:7400" } }, deps);
    const cfg = JSON.parse(readFileSync(layer2, "utf8"));
    expect(cfg.catalyst.readReplica.baseUrl).toBe("http://mini:7400");
  });
});

describe("runInstallLifecycle — failure handling", () => {
  test("backup failure ABORTS before any overwrite, no rollback (nothing changed)", async () => {
    const { deps, events, calls } = withRealRun(makeDeps({ failOn: (a) => (a[0] === "BACKUP" && a[1] === "backup" ? 1 : 0) }));
    const res = await runInstallLifecycle({ operation: "install", nodeClass: "worker", opts: {} }, deps);
    expect(res.outcome).toBe("failed");
    expect(res.bundlePath).toBeNull();
    // never reached write-config / install-agents
    const joined = calls.map((a) => a.join(" "));
    expect(joined.some((c) => c.includes("install-services"))).toBe(false);
    expect(joined.some((c) => c.includes("restore"))).toBe(false); // no rollback attempt
    expect(eventNames(events).at(-1)).toBe("catalyst.install.failed");
  });

  test("a failed provisioning phase ROLLS BACK from the captured bundle", async () => {
    const { deps, events, calls } = withRealRun(makeDeps({ failOn: (a) => (a.join(" ") === "STACK install-services" ? 3 : 0) }));
    const res = await runInstallLifecycle({ operation: "install", nodeClass: "worker", opts: {} }, deps);
    expect(res.outcome).toBe("rolled_back");
    const restore = calls.find((a) => a[0] === "BACKUP" && a[1] === "restore");
    expect(restore).toEqual(["BACKUP", "restore", "/tmp/bundle-xyz", "--force"]);
    expect(eventNames(events).at(-1)).toBe("catalyst.install.rolled_back");
  });

  test("an OPTIONAL step failure (drain) does not fail the run", async () => {
    const { deps } = withRealRun(makeDeps({ failOn: (a) => (a.join(" ") === "CATALYST drain" ? 1 : 0) }));
    const res = await runInstallLifecycle({ operation: "install", nodeClass: "developer", opts: {} }, deps);
    expect(res.outcome).toBe("completed");
  });

  test("healthcheck failure is NON-fatal: completed but healthOk=false, no rollback", async () => {
    const { deps, calls } = withRealRun(makeDeps({ failOn: (a) => (a.join(" ") === "STACK verify-node" ? 1 : 0) }));
    const res = await runInstallLifecycle({ operation: "install", nodeClass: "developer", opts: {} }, deps);
    expect(res.outcome).toBe("completed");
    expect(res.healthOk).toBe(false);
    expect(res.healthRc).toBe(1);
    expect(calls.some((a) => a[1] === "restore")).toBe(false);
  });
});

describe("runInstallLifecycle — idempotency", () => {
  test("re-running install produces the identical step sequence (converges)", async () => {
    const run1 = withRealRun(makeDeps());
    await runInstallLifecycle({ operation: "install", nodeClass: "worker", opts: {} }, run1.deps);
    const run2 = withRealRun(makeDeps());
    await runInstallLifecycle({ operation: "install", nodeClass: "worker", opts: {} }, run2.deps);
    const seq = (bag) => bag.calls.map((a) => a.join(" "));
    expect(seq(run1)).toEqual(seq(run2));
  });
});

describe("runInstallLifecycle — uninstall", () => {
  test("REFUSES a live, non-drained node without --force (no run started)", async () => {
    const { deps, events } = withRealRun(makeDeps({ daemonsLive: true, drained: false }));
    const res = await runInstallLifecycle({ operation: "uninstall", nodeClass: "worker", opts: { force: false } }, deps);
    expect(res.outcome).toBe("refused");
    expect(events).toHaveLength(0); // never emitted a started event
  });
  test("proceeds on a live node when DRAINED", async () => {
    const { deps } = withRealRun(makeDeps({ daemonsLive: true, drained: true }));
    const res = await runInstallLifecycle({ operation: "uninstall", nodeClass: "worker", opts: { force: false } }, deps);
    expect(res.outcome).toBe("completed");
  });
  test("proceeds on a live node with --force", async () => {
    const { deps } = withRealRun(makeDeps({ daemonsLive: true, drained: false }));
    const res = await runInstallLifecycle({ operation: "uninstall", nodeClass: "worker", opts: { force: true } }, deps);
    expect(res.outcome).toBe("completed");
  });
  test("remove-config strips install-managed keys but PRESERVES secrets", async () => {
    const initial = {
      catalyst: {
        node: { class: "developer" },
        orchestration: { pluginPullOwner: "updater", pluginDirs: "/x/plugins/dev" },
        readReplica: { baseUrl: "http://mini:7400" },
        secretKeep: "KEEP-ME",
      },
    };
    const { deps, layer2 } = withRealRun(makeDeps({ layer2Initial: initial }));
    const res = await runInstallLifecycle({ operation: "uninstall", nodeClass: "developer", opts: {} }, deps);
    expect(res.outcome).toBe("completed");
    const cfg = JSON.parse(readFileSync(layer2, "utf8"));
    // managed keys gone
    expect(cfg.catalyst.node?.class).toBeUndefined();
    expect(cfg.catalyst.orchestration?.pluginPullOwner).toBeUndefined();
    expect(cfg.catalyst.readReplica?.baseUrl).toBeUndefined();
    // secrets + unrelated keys preserved
    expect(cfg.catalyst.secretKeep).toBe("KEEP-ME");
    expect(cfg.catalyst.orchestration.pluginDirs).toBe("/x/plugins/dev");
  });
  test("verify-clean PASSES when no catalyst agents/daemons remain", async () => {
    const { deps } = withRealRun(makeDeps({ residual: false }));
    const res = await runInstallLifecycle({ operation: "uninstall", nodeClass: "worker", opts: { force: true } }, deps);
    expect(res.cleanOk).toBe(true);
  });
  test("a dirty teardown (residual agent survives) → outcome failed + catalyst.install.failed telemetry", async () => {
    const { deps, events } = withRealRun(makeDeps({ residual: true }));
    const res = await runInstallLifecycle({ operation: "uninstall", nodeClass: "developer", opts: { force: true } }, deps);
    expect(res.outcome).toBe("failed"); // NOT completed — a dirty teardown is a failure
    expect(res.cleanOk).toBe(false);
    expect(events.at(-1).event).toBe("catalyst.install.failed");
    expect(events.at(-1).detail.reason).toBe("dirty-teardown");
  });
});

describe("runInstallLifecycle — reinstall", () => {
  test("one backup, teardown THEN provisioning, operation=reinstall on every event", async () => {
    const { deps, events, calls } = withRealRun(makeDeps({ daemonsLive: false }));
    const res = await runInstallLifecycle({ operation: "reinstall", nodeClass: "developer", opts: { force: true } }, deps);
    expect(res.outcome).toBe("completed");
    const joined = calls.map((a) => a.join(" "));
    expect(joined.filter((c) => c.startsWith("BACKUP backup"))).toHaveLength(1);
    expect(joined).toContain("STACK uninstall-services"); // teardown
    expect(joined).toContain("STACK adopt-updater"); // provisioning
    for (const e of events) expect(e.operation).toBe("reinstall");
  });
  test("reinstall fails after teardown → rollback re-bootstraps to the RESTORED class (default worker), not the requested target", async () => {
    // `reinstall --class developer` on an ORIGINAL default-worker node (no node.class) that captured
    // agents; fail at write-config (before install-agents). After restore re-lays the classless config,
    // re-bootstrap must bring up the WORKER stack (install-services), NOT the requested developer's
    // adopt-updater — else the rolled-back worker loses its broker/exec-core.
    const { deps, calls } = withRealRun(makeDeps({ bundleHadAgents: true, failOn: (a) => (a.join(" ") === "SETUP --non-interactive" ? 1 : 0) }));
    const res = await runInstallLifecycle({ operation: "reinstall", nodeClass: "developer", opts: { force: true } }, deps);
    expect(res.outcome).toBe("rolled_back");
    expect(res.rollbackDisposition).toBe("ok");
    const joined = calls.map((a) => a.join(" "));
    const restoreIdx = joined.findIndex((c) => c.startsWith("BACKUP restore"));
    expect(restoreIdx).toBeGreaterThanOrEqual(0);
    expect(joined.lastIndexOf("STACK install-services")).toBeGreaterThan(restoreIdx); // worker re-bootstrap
    expect(joined.some((c) => c === "STACK adopt-updater")).toBe(false); // NOT the requested developer
  });
  test("reinstall whose failure PERSISTS through re-bootstrap → outcome failed (honest, not a false rolled_back)", async () => {
    // Worker reinstall, captured agents, install-services fails in BOTH provisioning and re-bootstrap.
    const { deps } = withRealRun(makeDeps({ bundleHadAgents: true, failOn: (a) => (a.join(" ") === "STACK install-services" ? 1 : 0) }));
    const res = await runInstallLifecycle({ operation: "reinstall", nodeClass: "worker", opts: { force: true } }, deps);
    expect(res.outcome).toBe("failed");
    expect(res.rollbackDisposition).toBe("failed");
  });
  test("reinstall on a config-only node (no captured agents) failing BEFORE install-agents → restore, no re-bootstrap", async () => {
    const { deps, calls } = withRealRun(makeDeps({ bundleHadAgents: false, failOn: (a) => (a.join(" ") === "SETUP --non-interactive" ? 1 : 0) }));
    const res = await runInstallLifecycle({ operation: "reinstall", nodeClass: "developer", opts: { force: true } }, deps);
    expect(res.outcome).toBe("rolled_back");
    const joined = calls.map((a) => a.join(" "));
    const restoreIdx = joined.findIndex((c) => c.startsWith("BACKUP restore"));
    // no agent bring-up after restore (the snapshot had none)
    expect(joined.slice(restoreIdx + 1).some((c) => c === "STACK install-services" || c === "STACK adopt-updater")).toBe(false);
  });
  test("reinstall on a config-only node that INSTALLS agents then fails → rollback boots out the newly-installed agents", async () => {
    // worker reinstall, no captured agents, install-agents (install-services) succeeds, start fails.
    const { deps, calls } = withRealRun(makeDeps({ bundleHadAgents: false, failOn: (a) => (a.join(" ") === "STACK start --yes" ? 1 : 0) }));
    const res = await runInstallLifecycle({ operation: "reinstall", nodeClass: "worker", opts: { force: true } }, deps);
    expect(res.outcome).toBe("rolled_back");
    const joined = calls.map((a) => a.join(" "));
    const provisionIdx = joined.lastIndexOf("STACK install-services");
    const restoreIdx = joined.findIndex((c) => c.startsWith("BACKUP restore"));
    expect(provisionIdx).toBeGreaterThanOrEqual(0); // provisioning installed the agents this run
    // rollback booted them out (uninstall-services) AFTER provisioning, BEFORE restore
    const bootedOut = joined.some((c, i) => c === "STACK uninstall-services" && i > provisionIdx && i < restoreIdx);
    expect(bootedOut).toBe(true);
  });
});

// ───────────────────────── adversarial-review remediations ─────────────────────────
describe("node-class env pinning (composed tools cannot diverge from --class)", () => {
  test("spawned steps inherit CATALYST_NODE_CLASS = resolved class, overriding a conflicting inherited env", async () => {
    const bag = withRealRun(makeDeps());
    bag.deps.env = { CATALYST_ASSUME_NO_DAEMONS: "1", CATALYST_NODE_CLASS: "worker" }; // operator shell exports worker
    await runInstallLifecycle({ operation: "install", nodeClass: "developer", opts: {} }, bag.deps);
    const adopt = bag.stepCalls.find((c) => c.argv.join(" ") === "STACK adopt-updater");
    expect(adopt.env.CATALYST_NODE_CLASS).toBe("developer"); // the lifecycle's target, NOT the inherited worker
    const verify = bag.stepCalls.find((c) => c.argv.join(" ") === "STACK verify-node");
    expect(verify.env.CATALYST_NODE_CLASS).toBe("developer");
  });
  test("spawned steps are pinned to the driver's Layer-2 file under BOTH config env names", async () => {
    const bag = withRealRun(makeDeps());
    await runInstallLifecycle({ operation: "install", nodeClass: "worker", opts: {} }, bag.deps);
    for (const c of bag.stepCalls) {
      expect(c.env.CATALYST_LAYER2_CONFIG_FILE).toBe(bag.layer2);
      expect(c.env.CATALYST_MACHINE_CONFIG).toBe(bag.layer2);
    }
  });
});

describe("fresh-node bootstrap + profile-switch guards (Codex round 5)", () => {
  test("spawned steps get ~/.bun/bin + ~/.local/bin seeded on PATH (so a post-setup tool is found)", async () => {
    const bag = withRealRun(makeDeps());
    bag.deps.env = { CATALYST_ASSUME_NO_DAEMONS: "1", HOME: "/home/me", PATH: "/usr/bin" };
    await runInstallLifecycle({ operation: "install", nodeClass: "developer", opts: {} }, bag.deps);
    const adopt = bag.stepCalls.find((c) => c.argv.join(" ") === "STACK adopt-updater");
    expect(adopt.env.PATH).toContain("/home/me/.bun/bin");
    expect(adopt.env.PATH).toContain("/usr/bin"); // original PATH preserved at the end
  });
  test("refuses fast when a hard prerequisite (jq) is missing — before any step runs", async () => {
    const bag = withRealRun(makeDeps({ missingBins: ["jq"] }));
    const res = await runInstallLifecycle({ operation: "install", nodeClass: "worker", opts: {} }, bag.deps);
    expect(res.outcome).toBe("refused");
    expect(res.reason).toBe("missing-prereq");
    expect(res.missing).toContain("jq");
    expect(bag.calls).toHaveLength(0);
  });
  test("install --class worker REFUSES on a node with a stale updater agent (two-puller hazard) → use reinstall", async () => {
    const bag = withRealRun(makeDeps({ updaterAgent: true }));
    const res = await runInstallLifecycle({ operation: "install", nodeClass: "worker", opts: {} }, bag.deps);
    expect(res.outcome).toBe("refused");
    expect(res.reason).toBe("stale-updater");
    expect(bag.calls).toHaveLength(0);
  });
  test("--force overrides the stale-updater guard; reinstall is never blocked by it", async () => {
    const forced = withRealRun(makeDeps({ updaterAgent: true }));
    expect((await runInstallLifecycle({ operation: "install", nodeClass: "worker", opts: { force: true } }, forced.deps)).outcome).toBe("completed");
    const re = withRealRun(makeDeps({ updaterAgent: true }));
    expect((await runInstallLifecycle({ operation: "reinstall", nodeClass: "worker", opts: { force: true } }, re.deps)).outcome).toBe("completed");
  });
  test("config-only reinstall rollback re-installs the CLI symlinks the teardown removed", async () => {
    // bundleHadAgents:false (config-only), fail at write-config; teardown ran install-cli --uninstall.
    const { deps, calls } = withRealRun(makeDeps({ bundleHadAgents: false, failOn: (a) => (a.join(" ") === "SETUP --non-interactive" ? 1 : 0) }));
    const res = await runInstallLifecycle({ operation: "reinstall", nodeClass: "worker", opts: { force: true } }, deps);
    expect(res.outcome).toBe("rolled_back");
    const joined = calls.map((a) => a.join(" "));
    const restoreIdx = joined.findIndex((c) => c.startsWith("BACKUP restore"));
    expect(joined.slice(restoreIdx + 1)).toContain("INSTALL_CLI"); // symlinks re-installed after restore
  });
  test("install --class developer over a LIVE worker stack REFUSES (mixed-profile guard)", async () => {
    const { deps, calls } = withRealRun(makeDeps({ daemonsLive: true }));
    const res = await runInstallLifecycle({ operation: "install", nodeClass: "developer", opts: {} }, deps);
    expect(res.outcome).toBe("refused");
    expect(res.reason).toBe("live-worker-stack");
    expect(calls).toHaveLength(0);
  });
  test("install retry on a LIVE existing node STOPS the worker stack around the restore (no live-restore corruption)", async () => {
    const { deps, calls } = withRealRun(makeDeps({ bundleHadAgents: true, daemonsLive: true, failOn: (a) => (a.join(" ") === "STACK install-services" ? 1 : 0) }));
    const res = await runInstallLifecycle({ operation: "install", nodeClass: "worker", opts: {} }, deps);
    expect(res.outcome).toBe("rolled_back");
    const joined = calls.map((a) => a.join(" "));
    const restoreIdx = joined.findIndex((c) => c.startsWith("BACKUP restore"));
    expect(joined.slice(0, restoreIdx)).toContain("STACK stop"); // stopped before restore
    expect(joined.slice(restoreIdx + 1)).toContain("STACK start --yes"); // restarted after
  });
  test("fresh-node rollback (EMPTY backup) removes the install-managed config keys + uninstalls the CLI symlinks", async () => {
    const { deps, calls, layer2 } = withRealRun(makeDeps({ bundleHadAgents: false, bundleEmpty: true, failOn: (a) => (a.join(" ") === "STACK install-services" ? 1 : 0) }));
    const res = await runInstallLifecycle({ operation: "install", nodeClass: "worker", opts: {} }, deps);
    expect(res.outcome).toBe("rolled_back");
    const joined = calls.map((a) => a.join(" "));
    const restoreIdx = joined.findIndex((c) => c.startsWith("BACKUP restore"));
    expect(joined.slice(restoreIdx + 1)).toContain("INSTALL_CLI --uninstall"); // symlinks removed
    const cfg = JSON.parse(readFileSync(layer2, "utf8") || "{}");
    expect(cfg.catalyst?.orchestration?.pluginPullOwner).toBeUndefined(); // managed key stripped
  });
  test("config-only daemonless install rollback (NON-empty backup) PRESERVES the node's saved settings", async () => {
    // install (not reinstall) on a configured-but-daemonless developer node that fails; the backup
    // captured its config (non-empty) → restore re-lays it → rollback must NOT strip node.class.
    const initial = { catalyst: { node: { class: "developer" }, readReplica: { baseUrl: "http://mini:7400" } } };
    const { deps, calls, layer2 } = withRealRun(makeDeps({ bundleHadAgents: false, bundleEmpty: false, layer2Initial: initial, failOn: (a) => (a.join(" ") === "STACK adopt-updater" ? 1 : 0) }));
    const res = await runInstallLifecycle({ operation: "install", nodeClass: "developer", opts: {} }, deps);
    expect(res.outcome).toBe("rolled_back");
    const joined = calls.map((a) => a.join(" "));
    expect(joined.some((c) => c === "INSTALL_CLI --uninstall")).toBe(false); // symlinks NOT removed
    const cfg = JSON.parse(readFileSync(layer2, "utf8") || "{}");
    expect(cfg.catalyst.node.class).toBe("developer"); // saved setting preserved
    expect(cfg.catalyst.readReplica.baseUrl).toBe("http://mini:7400");
  });
  test("install retry on an existing developer node whose updater step backed out → rollback re-bootstraps the updater", async () => {
    // hadAgents (updater plist captured), install (teardownRan=false), fail BEFORE install-agents so the
    // re-bootstrap's adopt-updater succeeds and brings the updater back.
    const initial = { catalyst: { node: { class: "developer" } } };
    const { deps, calls } = withRealRun(makeDeps({ bundleHadAgents: true, layer2Initial: initial, failOn: (a) => (a.join(" ") === "SETUP --non-interactive" ? 1 : 0) }));
    const res = await runInstallLifecycle({ operation: "install", nodeClass: "developer", opts: {} }, deps);
    expect(res.outcome).toBe("rolled_back");
    const joined = calls.map((a) => a.join(" "));
    const restoreIdx = joined.findIndex((c) => c.startsWith("BACKUP restore"));
    expect(joined.slice(restoreIdx + 1)).toContain("STACK adopt-updater"); // updater re-bootstrapped after restore
  });
});

describe("script preflight (fail fast before backup/teardown)", () => {
  test("refuses when a composed script is missing — no step ever runs (no backup taken)", async () => {
    const bag = withRealRun(makeDeps());
    bag.deps.scriptExists = (p) => p !== "SETUP"; // setup-catalyst.sh not found (cache-context)
    const res = await runInstallLifecycle({ operation: "install", nodeClass: "worker", opts: {} }, bag.deps);
    expect(res.outcome).toBe("refused");
    expect(res.reason).toBe("missing-script");
    expect(res.missing).toContain("SETUP");
    expect(bag.calls).toHaveLength(0);
  });
  test("uninstall does NOT require setup-catalyst.sh (only the scripts its plan uses)", async () => {
    const bag = withRealRun(makeDeps());
    bag.deps.scriptExists = (p) => p !== "SETUP"; // setup missing, but uninstall never invokes it
    const res = await runInstallLifecycle({ operation: "uninstall", nodeClass: "worker", opts: { force: true } }, bag.deps);
    expect(res.outcome).toBe("completed");
  });
});

describe("rollback is a true reversal + partial-state telemetry", () => {
  test("a failed provisioning phase boots out provisioned agents + stops + restores", async () => {
    const { deps, calls } = withRealRun(makeDeps({ failOn: (a) => (a.join(" ") === "STACK install-services" ? 3 : 0) }));
    const res = await runInstallLifecycle({ operation: "install", nodeClass: "worker", opts: {} }, deps);
    expect(res.outcome).toBe("rolled_back");
    expect(res.rollbackDisposition).toBe("ok");
    const joined = calls.map((a) => a.join(" "));
    expect(joined).toContain("STACK uninstall-services"); // booted out the freshly-provisioned agents
    expect(joined).toContain("STACK stop");
    expect(joined.some((c) => c.startsWith("BACKUP restore"))).toBe(true);
  });
  test("rollback-FAILURE (restore non-zero) → outcome failed + partial-state stamped in the terminal event", async () => {
    const { deps, events } = withRealRun(
      makeDeps({
        failOn: (a) => {
          const j = a.join(" ");
          if (j === "STACK install-services") return 3; // provisioning fails
          if (a[0] === "BACKUP" && a[1] === "restore") return 1; // AND rollback restore fails
          return 0;
        },
      }),
    );
    const res = await runInstallLifecycle({ operation: "install", nodeClass: "worker", opts: {} }, deps);
    expect(res.outcome).toBe("failed"); // NOT rolled_back — restore did not succeed
    expect(res.rollbackDisposition).toBe("failed");
    const last = events.at(-1);
    expect(last.event).toBe("catalyst.install.failed");
    expect(last.detail.rollback).toBe("failed"); // partial-state disposition in body
    expect(last.detail.bundle).toBe("/tmp/bundle-xyz"); // recovery pointer for the operator
  });
  test("rollback on a working node with pre-existing agents NEVER boots them out (uninstall-services)", async () => {
    const { deps, calls } = withRealRun(makeDeps({ bundleHadAgents: true, daemonsLive: true, failOn: (a) => (a.join(" ") === "STACK install-services" ? 3 : 0) }));
    const res = await runInstallLifecycle({ operation: "install", nodeClass: "worker", opts: {} }, deps);
    expect(res.outcome).toBe("rolled_back");
    const joined = calls.map((a) => a.join(" "));
    expect(joined).not.toContain("STACK uninstall-services"); // pre-existing agents never torn down
    expect(joined.some((c) => c.startsWith("BACKUP restore"))).toBe(true); // still restored
  });
  test("a benign abort (backup fails) carries rollback disposition 'none' (distinguishable from partial-state)", async () => {
    const { deps, events } = withRealRun(makeDeps({ failOn: (a) => (a[0] === "BACKUP" && a[1] === "backup" ? 1 : 0) }));
    const res = await runInstallLifecycle({ operation: "install", nodeClass: "worker", opts: {} }, deps);
    expect(res.outcome).toBe("failed");
    expect(res.rollbackDisposition).toBe("none");
    expect(events.at(-1).detail.rollback).toBe("none");
  });
});

describe("read-replica resolution (reinstall must not drop it)", () => {
  test("flag > env > current Layer-2 > null", () => {
    expect(resolveReadReplica({ flag: "http://flag:7400", env: {}, layer2: tmpCfg({}) })).toBe("http://flag:7400");
    expect(resolveReadReplica({ flag: null, env: { CATALYST_MONITOR_URL: "http://env:7400" }, layer2: tmpCfg({}) })).toBe("http://env:7400");
    expect(resolveReadReplica({ flag: null, env: {}, layer2: tmpCfg({ catalyst: { readReplica: { baseUrl: "http://cfg:7400" } } }) })).toBe("http://cfg:7400");
    expect(resolveReadReplica({ flag: null, env: {}, layer2: tmpCfg({}) })).toBeNull();
  });
});

describe("default trace-context generators (locked W3C widths)", () => {
  test("genTraceId is 32 hex chars, genSpanId is 16 hex chars", () => {
    const d = buildDefaultDeps({});
    expect(d.genTraceId()).toMatch(/^[0-9a-f]{32}$/);
    expect(d.genSpanId()).toMatch(/^[0-9a-f]{16}$/);
  });
});

// ───────────────────────── main: CLI exit codes ─────────────────────────
describe("main — CLI exit codes", () => {
  function capture(extra = {}) {
    const out = [];
    const errOut = [];
    return {
      out,
      errOut,
      depsOverride: { out: (m) => out.push(m), errOut: (m) => errOut.push(m), env: { CATALYST_ASSUME_NO_DAEMONS: "1" }, ...extra },
    };
  }

  test("--help prints usage, exit 0", async () => {
    const c = capture();
    const code = await main(["--help"], c.depsOverride);
    expect(code).toBe(0);
    expect(c.out.join("\n")).toContain("catalyst-install");
  });
  test("no operation → exit 2", async () => {
    const c = capture();
    expect(await main([], c.depsOverride)).toBe(2);
  });
  test("invalid operation → exit 2", async () => {
    const c = capture();
    expect(await main(["frobnicate"], c.depsOverride)).toBe(2);
  });
  test("invalid --class → exit 2", async () => {
    const c = capture();
    expect(await main(["install", "--class", "nope"], c.depsOverride)).toBe(2);
  });
  test("--dry-run prints the plan and runs nothing → exit 0", async () => {
    const c = capture();
    const code = await main(["install", "--class", "developer", "--dry-run"], c.depsOverride);
    expect(code).toBe(0);
    const text = c.out.join("\n");
    expect(text).toContain("dry-run");
    expect(text).toContain("adopt-updater");
    expect(text).not.toContain("install-services");
  });

  // Execute-path exit codes via full stub deps.
  function execDeps(over = {}) {
    const bag = withRealRun(makeDeps(over));
    const out = [];
    const errOut = [];
    return { out, errOut, depsOverride: { ...bag.deps, out: (m) => out.push(m), errOut: (m) => errOut.push(m) }, bag };
  }
  test("completed + healthy → exit 0", async () => {
    const d = execDeps();
    expect(await main(["install", "--class", "developer"], d.depsOverride)).toBe(0);
  });
  test("completed + unhealthy verify-node → exit 1", async () => {
    const d = execDeps({ failOn: (a) => (a.join(" ") === "STACK verify-node" ? 1 : 0) });
    expect(await main(["install", "--class", "developer"], d.depsOverride)).toBe(1);
  });
  test("failed provisioning → exit 1", async () => {
    const d = execDeps({ failOn: (a) => (a.join(" ") === "STACK adopt-updater" ? 1 : 0) });
    expect(await main(["install", "--class", "developer"], d.depsOverride)).toBe(1);
  });
  test("refused live node → exit 2", async () => {
    const d = execDeps({ daemonsLive: true, drained: false });
    expect(await main(["uninstall"], d.depsOverride)).toBe(2);
  });
  test("teardown that left agents present (cleanOk=false) → exit 1 (not a silent success)", async () => {
    const d = execDeps({ residual: true });
    expect(await main(["uninstall", "--force"], d.depsOverride)).toBe(1);
  });
  test("reinstall WITHOUT --read-replica preserves the configured endpoint (no data loss, exit 0)", async () => {
    const initial = { catalyst: { node: { class: "developer" }, readReplica: { baseUrl: "http://mini:7400" } } };
    const d = execDeps({ layer2Initial: initial });
    const code = await main(["reinstall", "--class", "developer", "--force"], d.depsOverride);
    expect(code).toBe(0);
    const cfg = JSON.parse(readFileSync(d.bag.layer2, "utf8"));
    expect(cfg.catalyst.readReplica.baseUrl).toBe("http://mini:7400");
  });
  test("--json on a successful run emits ONE stdout document (no trailing human line)", async () => {
    const d = execDeps();
    const code = await main(["install", "--class", "developer", "--json"], d.depsOverride);
    expect(code).toBe(0);
    expect(d.out).toHaveLength(1); // only the JSON, no "… completed." line
    expect(() => JSON.parse(d.out[0])).not.toThrow();
    expect(JSON.parse(d.out[0]).outcome).toBe("completed");
  });
  test("missing --class value → exit 2", async () => {
    const c = capture();
    expect(await main(["install", "--class"], c.depsOverride)).toBe(2);
  });
});

// ───────────────────────── seams + invariants ─────────────────────────
describe("resolveScripts seams", () => {
  test("env overrides win over computed defaults", () => {
    const s = resolveScripts({ CATALYST_INSTALL_SETUP_SCRIPT: "/custom/setup.sh", CATALYST_INSTALL_STACK_BIN: "/custom/stack" });
    expect(s.setup).toBe("/custom/setup.sh");
    expect(s.stack).toBe("/custom/stack");
  });
  test("computed defaults resolve real toolchain paths", () => {
    const s = resolveScripts({});
    expect(s.installCli).toMatch(/install-cli\.sh$/);
    expect(s.setup).toMatch(/setup-catalyst\.sh$/);
    expect(s.backup).toMatch(/catalyst-backup$/);
  });
  test("layer2Path honors CATALYST_LAYER2_CONFIG_FILE > CATALYST_MACHINE_CONFIG > XDG (no silent clobber)", () => {
    expect(layer2Path({ CATALYST_LAYER2_CONFIG_FILE: "/a.json", CATALYST_MACHINE_CONFIG: "/b.json" })).toBe("/a.json");
    expect(layer2Path({ CATALYST_MACHINE_CONFIG: "/b.json" })).toBe("/b.json");
    expect(layer2Path({ XDG_CONFIG_HOME: "/xdg" })).toBe("/xdg/catalyst/config.json");
  });
});

describe("invariants", () => {
  test("INSTALL_MANAGED_KEYS does not include any per-project secret file key", () => {
    // The keys are dotted Layer-2 paths, never the config-<key>.json secret files.
    for (const k of INSTALL_MANAGED_KEYS) expect(k).not.toMatch(/config-.*\.json/);
    expect(INSTALL_MANAGED_KEYS).toContain("catalyst.node.class");
  });
  test("usage() names all three operations", () => {
    const u = usage();
    for (const op of ["install", "uninstall", "reinstall"]) expect(u).toContain(op);
  });
  test("setDeepKey rejects prototype-chain segments (the pollution vector) and writes normal keys", () => {
    // setDeepKey creates intermediates, so an unsafe segment anywhere in the path is always reached.
    for (const bad of ["__proto__.polluted", "a.__proto__.x", "constructor.prototype.x", "a.prototype.b"]) {
      expect(() => setDeepKey({}, bad, 1)).toThrow(/unsafe config key segment/);
    }
    expect({}.polluted).toBeUndefined(); // Object.prototype untouched
    const o = {};
    setDeepKey(o, "catalyst.node.class", "developer");
    expect(o.catalyst.node.class).toBe("developer");
  });
  test("deleteDeepKey refuses an unsafe segment when reached; safely no-ops an absent path", () => {
    for (const bad of ["__proto__", "constructor.x", "__proto__.x"]) {
      expect(() => deleteDeepKey({}, bad)).toThrow(/unsafe config key segment/);
    }
    expect(deleteDeepKey({}, "a.b.c")).toBe(false); // absent intermediate → safe no-op (no throw, no write)
  });
  test("INSTALL_MANAGED_KEYS contains no unsafe segments", () => {
    for (const k of INSTALL_MANAGED_KEYS) for (const seg of k.split(".")) expect(["__proto__", "prototype", "constructor"]).not.toContain(seg);
  });
});
