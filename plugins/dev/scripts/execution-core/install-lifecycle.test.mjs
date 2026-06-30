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

import { INSTALL_PHASES, INSTALL_EVENT } from "./lib/install-telemetry.mjs";
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
  upsertEnvFile,
  VALID_EXECUTORS,
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
  doctor: "DOCTOR", // CTL-1369 PR4: the pre/post-install doctor pass (catalyst-doctor --profile install)
};

// makeDeps — a fully-stubbed dep set. `failOn` is a predicate (argv|joined → truthy = fail with
// that rc). `bundle` is the path catalyst-backup "prints". probeDaemons/probeDrained are flags.
function makeDeps({ failOn, bundle = "/tmp/bundle-xyz", daemonsLive = false, residual = false, drained = false, bundleHadAgents = false, updaterAgent = false, workerAgents = false, cliInstalled = false, restorePluginDirs, acquireWritesPluginDirs, missingBins = [], layer2Initial } = {}) {
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
      if (argv[0] === "PLUGIN_SRC" && acquireWritesPluginDirs !== undefined) {
        // simulate setup-plugin-source.sh repointing pluginDirs to the canonical checkout (pre-backup)
        const cfg = JSON.parse(readFileSync(layer2, "utf8") || "{}");
        cfg.catalyst = cfg.catalyst || {};
        cfg.catalyst.orchestration = cfg.catalyst.orchestration || {};
        cfg.catalyst.orchestration.pluginDirs = acquireWritesPluginDirs;
        writeFileSync(layer2, JSON.stringify(cfg));
      }
      if (argv[0] === "BACKUP" && argv[1] === "backup") return { code: 0, stdout: `capturing…\n${bundle}\n`, stderr: "" };
      if (argv[0] === "BACKUP" && argv[1] === "restore" && restorePluginDirs !== undefined) {
        // simulate restore re-laying the captured (post-acquire) pluginDirs into the config
        const cfg = JSON.parse(readFileSync(layer2, "utf8") || "{}");
        cfg.catalyst = cfg.catalyst || {};
        cfg.catalyst.orchestration = cfg.catalyst.orchestration || {};
        cfg.catalyst.orchestration.pluginDirs = restorePluginDirs;
        writeFileSync(layer2, JSON.stringify(cfg));
      }
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
    probeUpdaterAgent: () => updaterAgent,
    probeWorkerAgents: () => workerAgents,
    probeCliInstalled: () => cliInstalled,
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
  test("CTL-1401: --executor parses (space + equals forms); missing value is an error", () => {
    expect(parseArgs(["install", "--executor", "sdk"]).executor).toBe("sdk");
    expect(parseArgs(["reinstall", "--executor=bg"]).executor).toBe("bg");
    expect(parseArgs(["install"]).executor).toBeNull(); // omitted ⇒ null ⇒ untouched
    expect(parseArgs(["install", "--executor"]).errors).toContain("--executor requires a value");
    expect(parseArgs(["install", "--executor="]).errors).toContain("--executor requires a value");
    // the valid set the install accepts (asserted against the exported constant)
    expect(VALID_EXECUTORS).toEqual(["bg", "sdk", "oneshot-legacy"]);
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
  test("a present-but-non-string config class fails closed (no String() coercion to worker / bogus class)", () => {
    expect(() => resolveRequestedClass({ env: {}, layer2: tmpCfg({ catalyst: { node: { class: [] } } }) })).toThrow(/malformed node class/);
    expect(() => resolveRequestedClass({ env: {}, layer2: tmpCfg({ catalyst: { node: { class: ["developer"] } } }) })).toThrow(/malformed node class/);
    expect(() => resolveRequestedClass({ env: {}, layer2: tmpCfg({ catalyst: { node: { class: 0 } } }) })).toThrow(/malformed node class/);
  });
});

describe("isDrainedStatus (teardown guard requires zero in-flight, not just draining)", () => {
  test("draining with zero in-flight ⇒ drained; with in-flight or UNKNOWN count ⇒ not drained", () => {
    expect(isDrainedStatus({ draining: true, inFlightCount: 0 })).toBe(true);
    expect(isDrainedStatus({ draining: true, inFlightCount: 3 })).toBe(false); // work still landing
    expect(isDrainedStatus({ draining: true })).toBe(false); // MISSING count ⇒ unknown ⇒ fail closed
    expect(isDrainedStatus({ draining: true, inflight: 0 })).toBe(true); // alternate key name
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
  // CTL-1369 PR4: the healthcheck phase runs verify-node AND the class-aware doctor (--profile install).
  test("install/reinstall healthcheck runs verify-node then doctor (--profile install); uninstall has neither", () => {
    for (const operation of ["install", "reinstall"]) {
      const hc = planPhases({ operation, nodeClass: "worker", scripts: SCRIPTS }).find((p) => p.phase === "healthcheck");
      const labels = hc.steps.map((s) => s.label);
      expect(labels).toEqual(["verify-node", "doctor"]);
      const doctorStep = hc.steps.find((s) => s.label === "doctor");
      expect(doctorStep.kind).toBe("doctor");
      expect(doctorStep.argv).toEqual(["DOCTOR", "--profile", "install", "--json"]);
    }
    // uninstall ends with verify-clean — no healthcheck phase, no doctor step.
    expect(planPhases({ operation: "uninstall", nodeClass: "worker", scripts: SCRIPTS }).some((p) => p.phase === "healthcheck")).toBe(false);
    expect(stepLabels(planPhases({ operation: "uninstall", nodeClass: "worker", scripts: SCRIPTS }))).not.toContain("doctor");
  });
});

// ───────────────────────── CTL-1401: cloud-sync + executor provisioning ─────────────────────────
describe("planPhases — CTL-1401 cloud-sync + executor levers (pure)", () => {
  test("adopt-cloud-sync is in install-agents for EVERY class (install + reinstall), ordered AFTER the class step", () => {
    for (const operation of ["install", "reinstall"]) {
      for (const nodeClass of ["worker", "developer", "monitor"]) {
        const ia = planPhases({ operation, nodeClass, scripts: SCRIPTS }).find((p) => p.phase === "install-agents");
        const labels = ia.steps.map((s) => s.label);
        expect(labels).toContain("adopt-cloud-sync");
        // it must come after the per-class agent step so install-services has laid down the log-shipper
        const classStep = nodeClass === "worker" ? "install-services" : "adopt-updater";
        expect(labels.indexOf("adopt-cloud-sync")).toBeGreaterThan(labels.indexOf(classStep));
        const step = ia.steps.find((s) => s.label === "adopt-cloud-sync");
        expect(step).toMatchObject({ kind: "run", argv: ["STACK", "adopt-cloud-sync"], optional: true });
      }
    }
  });
  test("set-executor setenv step appears in write-config ONLY when --executor is given", () => {
    const withExec = planPhases({ operation: "install", nodeClass: "worker", scripts: SCRIPTS, opts: { executor: "sdk", execCoreEnv: "/tmp/ec.env" } }).find((p) => p.phase === "write-config");
    const setExec = withExec.steps.find((s) => s.label === "set-executor");
    expect(setExec).toMatchObject({ kind: "setenv", file: "/tmp/ec.env", key: "CATALYST_EXECUTOR", value: "sdk" });
    // no flag ⇒ no step ⇒ the node's existing executor is left untouched
    const noExec = planPhases({ operation: "install", nodeClass: "worker", scripts: SCRIPTS }).find((p) => p.phase === "write-config");
    expect(noExec.steps.some((s) => s.label === "set-executor")).toBe(false);
  });
  test("set-executor works for every class + on reinstall (the lever is class-agnostic)", () => {
    for (const operation of ["install", "reinstall"]) {
      for (const nodeClass of ["worker", "developer", "monitor"]) {
        const wc = planPhases({ operation, nodeClass, scripts: SCRIPTS, opts: { executor: "bg", execCoreEnv: "/tmp/ec.env" } }).find((p) => p.phase === "write-config");
        expect(wc.steps.some((s) => s.label === "set-executor" && s.value === "bg")).toBe(true);
      }
    }
  });
});

describe("upsertEnvFile — CTL-1401 idempotent env-file upsert", () => {
  test("creates a fresh file with export KEY=value", () => {
    const f = tmpCfg();
    upsertEnvFile(f, "CATALYST_EXECUTOR", "sdk");
    expect(readFileSync(f, "utf8")).toBe("export CATALYST_EXECUTOR=sdk\n");
  });
  test("replaces an existing KEY line (with or without `export`) and preserves all other lines", () => {
    const f = tmpCfg();
    writeFileSync(f, "# header\nexport OTEL_EXPORTER_OTLP_ENDPOINT=http://h:4318\nCATALYST_EXECUTOR=bg\nexport CATALYST_LINEAR_REPLICA=on\n");
    upsertEnvFile(f, "CATALYST_EXECUTOR", "sdk");
    const out = readFileSync(f, "utf8");
    expect(out).toBe("# header\nexport OTEL_EXPORTER_OTLP_ENDPOINT=http://h:4318\nexport CATALYST_EXECUTOR=sdk\nexport CATALYST_LINEAR_REPLICA=on\n");
  });
  test("is idempotent (re-running yields byte-identical content, single line)", () => {
    const f = tmpCfg();
    upsertEnvFile(f, "CATALYST_EXECUTOR", "sdk");
    const once = readFileSync(f, "utf8");
    upsertEnvFile(f, "CATALYST_EXECUTOR", "sdk");
    expect(readFileSync(f, "utf8")).toBe(once);
    expect(readFileSync(f, "utf8").match(/CATALYST_EXECUTOR=/g)).toHaveLength(1);
  });
});

describe("runInstallLifecycle — CTL-1401 executor + cloud-sync provisioning (integration)", () => {
  test("worker install --executor sdk writes execution-core.env AND adopts cloud-sync", async () => {
    const ecEnv = tmpCfg(); // empty/absent → upsert creates it fresh
    const bag = withRealRun(makeDeps());
    await runInstallLifecycle({ operation: "install", nodeClass: "worker", opts: { executor: "sdk", execCoreEnv: ecEnv } }, bag.deps);
    // the SDK executor lever is durably provisioned into execution-core.env
    expect(readFileSync(ecEnv, "utf8")).toContain("export CATALYST_EXECUTOR=sdk");
    // and the cloud-sync writer was adopted (the regression fix)
    expect(bag.calls.some((argv) => argv[0] === "STACK" && argv[1] === "adopt-cloud-sync")).toBe(true);
  });
  test("a reinstall WITHOUT --executor never touches execution-core.env (preserve, not clobber)", async () => {
    const ecEnv = tmpCfg();
    writeFileSync(ecEnv, "export CATALYST_EXECUTOR=sdk\nexport CATALYST_LINEAR_REPLICA=on\n");
    const before = readFileSync(ecEnv, "utf8");
    const bag = withRealRun(makeDeps());
    await runInstallLifecycle({ operation: "reinstall", nodeClass: "worker", opts: { execCoreEnv: ecEnv } }, bag.deps);
    expect(readFileSync(ecEnv, "utf8")).toBe(before); // survived byte-for-byte
    // cloud-sync is still re-adopted on a reinstall (teardown removed it)
    expect(bag.calls.some((argv) => argv[0] === "STACK" && argv[1] === "adopt-cloud-sync")).toBe(true);
  });
});

// ───────────────────────── CTL-1369 PR4: doctor pre/post-install pass ─────────────────────────
describe("runInstallLifecycle — doctor pre/post-install pass (CTL-1369 PR4)", () => {
  // Inject a runDoctorPass returning a fixed summary so the pre/post passes are deterministic.
  const withDoctor = (summary, over = {}) => {
    const bag = withRealRun(makeDeps(over));
    bag.deps.runDoctorPass = () => summary;
    return bag;
  };

  // Both provisioning ops (install AND reinstall) capture the before-snapshot — parametrized so the
  // `|| operation === "reinstall"` arm is genuinely exercised (a future narrowing to install-only fails here).
  for (const operation of ["install", "reinstall"]) {
    test(`the ${operation} started event carries the pre-install doctor before-snapshot; completed carries the after`, async () => {
      const summary = { ok: false, rc: 1, counts: { pass: 1, warn: 0, fail: 1 }, fails: ["agents-for-class"] };
      const { deps, events } = withDoctor(summary); // makeDeps default daemonsLive=false → reinstall passes the teardown guard
      await runInstallLifecycle({ operation, nodeClass: "worker", opts: {} }, deps);
      const started = events.find((e) => e.event === INSTALL_EVENT.started);
      const completed = events.find((e) => e.event === INSTALL_EVENT.completed);
      expect(started.detail.preDoctor).toEqual(summary); // before-state observable in the trace
      expect(completed.detail.postDoctor).toEqual(summary); // after-state too
    });
  }

  test("a post-install doctor FAIL → outcome completed (node IS installed) but doctorOk=false", async () => {
    const { deps } = withDoctor({ ok: false, rc: 1, counts: { pass: 1, warn: 0, fail: 1 }, fails: ["agents-for-class"] });
    const res = await runInstallLifecycle({ operation: "install", nodeClass: "worker", opts: {} }, deps);
    expect(res.outcome).toBe("completed");
    expect(res.doctorOk).toBe(false);
    expect(res.doctorFails).toEqual(["agents-for-class"]);
  });

  test("a post-install doctor PASS → doctorOk=true", async () => {
    const { deps } = withDoctor({ ok: true, rc: 0, counts: { pass: 3, warn: 0, fail: 0 }, fails: [] });
    const res = await runInstallLifecycle({ operation: "install", nodeClass: "worker", opts: {} }, deps);
    expect(res.outcome).toBe("completed");
    expect(res.doctorOk).toBe(true);
  });

  test("a doctor that can't run (ok:null) is ADVISORY — doctorOk stays true (never fails a good install)", async () => {
    const { deps } = withDoctor({ ok: null, rc: 127, counts: null, fails: null });
    const res = await runInstallLifecycle({ operation: "install", nodeClass: "worker", opts: {} }, deps);
    expect(res.outcome).toBe("completed");
    expect(res.doctorOk).toBe(true);
  });

  test("uninstall does NOT run a pre-install doctor (no before-snapshot on a teardown-only op)", async () => {
    const { deps, events } = withDoctor({ ok: true, rc: 0, counts: { pass: 3, warn: 0, fail: 0 }, fails: [] }, { drained: true });
    await runInstallLifecycle({ operation: "uninstall", nodeClass: "worker", opts: { force: true } }, deps);
    const started = events.find((e) => e.event === INSTALL_EVENT.started);
    expect(started.detail.preDoctor ?? null).toBeNull();
  });

  test("the pre-install doctor is OBSERVE-only — a FAIL before-state does NOT refuse a fresh install", async () => {
    // Fresh worker: pre-install doctor FAILs (no agents yet) but the install must still proceed.
    const { deps } = withDoctor({ ok: false, rc: 1, counts: { pass: 0, warn: 0, fail: 2 }, fails: ["agents-for-class", "node-class"] });
    const res = await runInstallLifecycle({ operation: "install", nodeClass: "worker", opts: {} }, deps);
    expect(res.outcome).toBe("completed"); // proceeded despite the FAIL before-state
  });

  // The PRODUCTION parser (defaultRunDoctorPass) — exercised by OMITTING deps.runDoctorPass and feeding
  // representative `catalyst-doctor --json` stdout through the lifecycle's runStep seam. This pins the
  // load-bearing coupling to doctor's renderJson shape (status==="fail" ↔ STATUS.FAIL, ok/counts/checks).
  const withDoctorStdout = ({ code, stdout }) => {
    const bag = withRealRun(makeDeps());
    const orig = bag.deps.runStep;
    bag.deps.runStep = (call) => (call.argv[0] === "DOCTOR" ? { code, stdout, stderr: "" } : orig(call));
    // NB: deliberately NOT setting bag.deps.runDoctorPass → defaultRunDoctorPass parses for real.
    return bag;
  };

  test("defaultRunDoctorPass parses real doctor JSON into { ok, rc, counts, fails }", async () => {
    const doctorJson = JSON.stringify({
      ok: false,
      counts: { pass: 1, warn: 0, fail: 1 },
      checks: [{ name: "agents-for-class", status: "fail" }, { name: "node-class", status: "pass" }],
    });
    const { deps, events } = withDoctorStdout({ code: 1, stdout: doctorJson });
    const res = await runInstallLifecycle({ operation: "install", nodeClass: "worker", opts: {} }, deps);
    expect(res.doctorOk).toBe(false);
    expect(res.doctorFails).toEqual(["agents-for-class"]); // only the fail-status check names
    const completed = events.find((e) => e.event === INSTALL_EVENT.completed);
    expect(completed.detail.postDoctor).toMatchObject({ ok: false, rc: 1, counts: { pass: 1, warn: 0, fail: 1 }, fails: ["agents-for-class"] });
  });

  test("defaultRunDoctorPass degrades unparseable doctor stdout to ok:null (advisory — install not failed)", async () => {
    const { deps } = withDoctorStdout({ code: 2, stdout: "{not valid json" });
    const res = await runInstallLifecycle({ operation: "install", nodeClass: "worker", opts: {} }, deps);
    expect(res.outcome).toBe("completed");
    expect(res.doctorOk).toBe(true); // ok:null → advisory
  });

  test("a post-install doctor that THROWS is advisory — the install completes, NOT rolled back (best-effort invariant)", async () => {
    const bag = withRealRun(makeDeps());
    bag.deps.runDoctorPass = () => { throw new Error("doctor blew up"); };
    const res = await runInstallLifecycle({ operation: "install", nodeClass: "worker", opts: {} }, bag.deps);
    expect(res.outcome).toBe("completed"); // a throwing doctor must NOT propagate → rollback
    expect(res.doctorOk).toBe(true); // degraded to advisory
  });

  // Codex P2 (thread 1): the advisory doctor binary is NOT a hard install prerequisite.
  test("an ABSENT catalyst-doctor binary does NOT refuse the install (excluded from the missing-script preflight)", async () => {
    const bag = withRealRun(makeDeps());
    bag.deps.scriptExists = (p) => p !== "DOCTOR"; // doctor missing, every other composed script present
    const res = await runInstallLifecycle({ operation: "install", nodeClass: "worker", opts: {} }, bag.deps);
    expect(res.outcome).not.toBe("refused"); // a missing advisory verifier must not block provisioning
    expect(res.outcome).toBe("completed");
    expect(res.doctorOk).toBe(true); // doctor couldn't run → advisory (ok:null)
  });

  // Codex P2 (round 3): the doctor must verify the PERSISTED class, not the requested class pinned in env.
  test("the doctor pre/post passes CLEAR CATALYST_NODE_CLASS (verify Layer-2 class) but keep CATALYST_LAYER2_CONFIG_FILE", async () => {
    const bag = withRealRun(makeDeps());
    bag.deps.env = { ...bag.deps.env, CATALYST_NODE_CLASS: "worker" }; // operator shell exports a conflicting class
    const doctorEnvs = [];
    bag.deps.runDoctorPass = ({ env }) => { doctorEnvs.push(env); return { ok: true, rc: 0, counts: { pass: 3, warn: 0, fail: 0 }, fails: [] }; };
    await runInstallLifecycle({ operation: "install", nodeClass: "developer", opts: {} }, bag.deps);
    expect(doctorEnvs.length).toBeGreaterThan(0); // pre + post
    for (const env of doctorEnvs) {
      expect(env.CATALYST_NODE_CLASS).toBe(""); // cleared → resolveNodeClass falls through to Layer-2 (the persisted class)
      expect(env.CATALYST_LAYER2_CONFIG_FILE).toBe(bag.layer2); // but still points at the install's config
    }
    // the COMPOSED bash tools, by contrast, still get the requested class pinned (adopt-updater must act on it).
    const adopt = bag.stepCalls.find((c) => c.argv.join(" ") === "STACK adopt-updater");
    expect(adopt.env.CATALYST_NODE_CLASS).toBe("developer");
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
    expect(adopt.env.PATH).toContain("/home/me/.catalyst/bin"); // CLI bin dir (just-installed symlinks)
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
  test("install --class developer over a STOPPED-but-installed worker stack also REFUSES", async () => {
    const { deps } = withRealRun(makeDeps({ daemonsLive: false, workerAgents: true }));
    const res = await runInstallLifecycle({ operation: "install", nodeClass: "developer", opts: {} }, deps);
    expect(res.outcome).toBe("refused");
    expect(res.reason).toBe("live-worker-stack");
  });
  test("live-agent rollback: a FAILED stop skips the restore (no --force over live daemons) → failed", async () => {
    const { deps, calls } = withRealRun(makeDeps({ bundleHadAgents: true, daemonsLive: true, failOn: (a) => (["STACK install-services", "STACK stop"].includes(a.join(" ")) ? 1 : 0) }));
    const res = await runInstallLifecycle({ operation: "install", nodeClass: "worker", opts: {} }, deps);
    expect(res.outcome).toBe("failed");
    expect(calls.some((a) => a[0] === "BACKUP" && a[1] === "restore")).toBe(false); // never restored over a live stack
  });
  test("live-agent rollback: a FAILED restart → incomplete rollback (outcome failed)", async () => {
    const { deps } = withRealRun(makeDeps({ bundleHadAgents: true, daemonsLive: true, failOn: (a) => (["STACK install-services", "STACK start --yes"].includes(a.join(" ")) ? 1 : 0) }));
    const res = await runInstallLifecycle({ operation: "install", nodeClass: "worker", opts: {} }, deps);
    expect(res.outcome).toBe("failed"); // restore ok but the stack didn't come back up
  });
  test("live-agent rollback restarts with the RESTORED class env, not the requested target", async () => {
    // reinstall --class developer over a worker whose stop didn't quiesce (daemonsLive stays true).
    const { deps, stepCalls } = withRealRun(makeDeps({ bundleHadAgents: true, daemonsLive: true, layer2Initial: { catalyst: { node: { class: "worker" } } }, failOn: (a) => (a.join(" ") === "STACK adopt-updater" ? 1 : 0) }));
    await runInstallLifecycle({ operation: "reinstall", nodeClass: "developer", opts: { force: true } }, deps);
    const start = stepCalls.find((c) => c.argv.join(" ") === "STACK start --yes");
    expect(start.env.CATALYST_NODE_CLASS).toBe("worker"); // restored class, NOT the requested developer
  });
  test("fresh-node rollback whose boot-out (cleanup) FAILS → incomplete + SKIPS the restore (no --force over live daemons)", async () => {
    const { deps, calls } = withRealRun(makeDeps({ bundleHadAgents: false, failOn: (a) => (["STACK install-services", "STACK uninstall-services"].includes(a.join(" ")) ? 1 : 0) }));
    const res = await runInstallLifecycle({ operation: "install", nodeClass: "worker", opts: {} }, deps);
    expect(res.outcome).toBe("failed");
    expect(calls.some((a) => a[0] === "BACKUP" && a[1] === "restore")).toBe(false); // never restored over possibly-live daemons
  });
  test("backup failing AFTER acquire repointed pluginDirs still restores the prior value (no bundle)", async () => {
    const { deps, layer2 } = withRealRun(
      makeDeps({
        layer2Initial: { catalyst: { orchestration: { pluginDirs: "/custom/checkout/plugins/dev" } } },
        acquireWritesPluginDirs: "/canonical/plugin-source/plugins/dev",
        failOn: (a) => (a[0] === "BACKUP" && a[1] === "backup" ? 1 : 0),
      }),
    );
    const res = await runInstallLifecycle({ operation: "install", nodeClass: "worker", opts: {} }, deps);
    expect(res.outcome).toBe("failed"); // backup abort (no rollback bundle)
    expect(res.bundlePath).toBeNull();
    const cfg = JSON.parse(readFileSync(layer2, "utf8") || "{}");
    expect(cfg.catalyst.orchestration.pluginDirs).toBe("/custom/checkout/plugins/dev"); // prior value restored even without a bundle
  });
  test("install rollback restores the node's prior pluginDirs that acquire overwrote", async () => {
    // node had a custom pluginDirs; restore re-lays the post-acquire (canonical) value → rollback writes back custom.
    const { deps, layer2 } = withRealRun(
      makeDeps({
        bundleHadAgents: false,
        cliInstalled: true,
        layer2Initial: { catalyst: { node: { class: "developer" }, orchestration: { pluginDirs: "/custom/checkout/plugins/dev" } } },
        restorePluginDirs: "/canonical/plugin-source/plugins/dev",
        failOn: (a) => (a.join(" ") === "STACK adopt-updater" ? 1 : 0),
      }),
    );
    const res = await runInstallLifecycle({ operation: "install", nodeClass: "developer", opts: {} }, deps);
    expect(res.outcome).toBe("rolled_back");
    const cfg = JSON.parse(readFileSync(layer2, "utf8") || "{}");
    expect(cfg.catalyst.orchestration.pluginDirs).toBe("/custom/checkout/plugins/dev"); // prior value restored
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
    const { deps, calls, layer2 } = withRealRun(makeDeps({ bundleHadAgents: false, cliInstalled: false, failOn: (a) => (a.join(" ") === "STACK install-services" ? 1 : 0) }));
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
    const { deps, calls, layer2 } = withRealRun(makeDeps({ bundleHadAgents: false, cliInstalled: true, layer2Initial: initial, failOn: (a) => (a.join(" ") === "STACK adopt-updater" ? 1 : 0) }));
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
  test("CTL-1401: invalid --executor → exit 2 (a typo must not silently leave the node on a default)", async () => {
    const c = capture();
    expect(await main(["install", "--class", "worker", "--executor", "turbo"], c.depsOverride)).toBe(2);
    expect(c.errOut.join("\n")).toContain("--executor must be one of");
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
  test("CTL-1401: --dry-run renders the set-executor setenv + adopt-cloud-sync steps (value shown, no crash)", async () => {
    const c = capture();
    const code = await main(["install", "--class", "worker", "--executor", "sdk", "--dry-run"], c.depsOverride);
    expect(code).toBe(0);
    const text = c.out.join("\n");
    expect(text).toContain("adopt-cloud-sync");
    expect(text).toContain("set-executor");
    expect(text).toContain("CATALYST_EXECUTOR=sdk");
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
  // CTL-1369 PR4: the post-install doctor verdict folds into the command exit code.
  test("completed install but post-install doctor FAIL → exit 1, with a class-correctness message", async () => {
    const d = execDeps();
    const code = await main(["install", "--class", "worker"], {
      ...d.depsOverride,
      runDoctorPass: () => ({ ok: false, rc: 1, counts: { pass: 1, warn: 0, fail: 1 }, fails: ["agents-for-class"] }),
    });
    expect(code).toBe(1);
    expect(d.errOut.join("\n")).toMatch(/NOT class-correct.*agents-for-class/);
  });
  test("completed install, doctor PASS → exit 0", async () => {
    const d = execDeps();
    const code = await main(["install", "--class", "worker"], {
      ...d.depsOverride,
      runDoctorPass: () => ({ ok: true, rc: 0, counts: { pass: 3, warn: 0, fail: 0 }, fails: [] }),
    });
    expect(code).toBe(0);
  });
  test("completed install, doctor advisory (ok:null, couldn't run) → exit 0 (never fails a good install)", async () => {
    const d = execDeps();
    const code = await main(["install", "--class", "worker"], {
      ...d.depsOverride,
      runDoctorPass: () => ({ ok: null, rc: 127, counts: null, fails: null }),
    });
    expect(code).toBe(0);
  });
});

// ───────────────────────── seams + invariants ─────────────────────────
describe("resolveScripts seams", () => {
  test("env overrides win over computed defaults", () => {
    const s = resolveScripts({ CATALYST_INSTALL_SETUP_SCRIPT: "/custom/setup.sh", CATALYST_INSTALL_STACK_BIN: "/custom/stack", CATALYST_INSTALL_DOCTOR_BIN: "/custom/doctor" });
    expect(s.setup).toBe("/custom/setup.sh");
    expect(s.stack).toBe("/custom/stack");
    expect(s.doctor).toBe("/custom/doctor"); // CTL-1369 PR4 seam
  });
  test("computed defaults resolve real toolchain paths", () => {
    const s = resolveScripts({});
    expect(s.installCli).toMatch(/install-cli\.sh$/);
    expect(s.setup).toMatch(/setup-catalyst\.sh$/);
    expect(s.backup).toMatch(/catalyst-backup$/);
    expect(s.doctor).toMatch(/catalyst-doctor$/); // CTL-1369 PR4
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
