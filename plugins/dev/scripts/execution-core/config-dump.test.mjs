// config-dump.test.mjs — CTL-1793.
// Run: cd plugins/dev/scripts/execution-core && bun test config-dump.test.mjs
//
// The dump is a DESCRIPTION of the real resolution ladders, so the tests come in
// three families:
//   (1) provenance — each layer wins where it should, per kind;
//   (2) safety — no secret value can reach either renderer;
//   (3) DRIFT — every env var and dotted key in CONFIG_KEYS is pinned to the real
//       source files, so a rename in a reader breaks this test instead of
//       silently drifting the dump.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CONFIG_KEYS,
  DUMP_SCHEMA,
  collectConfigDump,
  PROVENANCE,
  dumpConfig,
  fingerprintRows,
  getPath,
  overlayEnvFile,
  parseEnvFileAssignments,
  parseEnvFileEntries,
  parseEnvFileExports,
  renderHuman,
  renderJson,
  resolveDaemonLayer1Path,
  resolveRow,
} from "./config-dump.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = resolve(HERE, "..");

const row = (dump, key) => dump.rows.find((r) => r.key === key);

// A minimal dump over injected fixtures — zero ambient I/O.
function dump(over = {}) {
  return dumpConfig({
    env: {},
    host: "test-host",
    generatedAt: "2026-08-11T00:00:00.000Z",
    layer1Path: "/repo/.catalyst/config.json",
    layer2Path: "/home/u/.config/catalyst/config.json",
    layer1Text: null,
    layer2Text: null,
    execCoreEnvText: "",
    ...over,
  });
}

describe("env-file parsing (the daemon's effective env)", () => {
  test("parses export/bare/quoted assignments and skips comments", () => {
    const parsed = parseEnvFileAssignments(
      ["# a comment", "", 'export CATALYST_STALL_JANITOR="enforce"', "CATALYST_BOARD_HEALTH=shadow", "  export A='b'  ", "not-an-assignment"].join("\n"),
    );
    expect(parsed).toEqual({ CATALYST_STALL_JANITOR: "enforce", CATALYST_BOARD_HEALTH: "shadow", A: "b" });
  });

  test("file wins over ambient env (matches `source` semantics)", () => {
    expect(overlayEnvFile({ X: "ambient", Y: "keep" }, "export X=file")).toEqual({ X: "file", Y: "keep" });
  });

  // The launcher plain-`source`s the env file with NO `set -a`
  // (catalyst-execution-core:214), and a child inherits only EXPORTED vars. Both
  // live fleet files export every assignment (mini 23/23, mini-2 14/14), so this
  // distinction is a guard against a future bare line, not a description of today.
  test("a BARE assignment is not part of the daemon's effective env", () => {
    expect(overlayEnvFile({ Y: "keep" }, "X=bare")).toEqual({ Y: "keep" });
    expect(overlayEnvFile({ X: "ambient" }, "X=bare")).toEqual({ X: "ambient" });
  });

  test("parseEnvFileEntries records the export flag per assignment", () => {
    expect(parseEnvFileEntries("export A=1\nB=2\n")).toEqual([
      { key: "A", value: "1", exported: true },
      { key: "B", value: "2", exported: false },
    ]);
  });

  test("parseEnvFileAssignments keeps the launcher-shell view (bare included)", () => {
    expect(parseEnvFileAssignments("export A=1\nB=2\n")).toEqual({ A: "1", B: "2" });
    expect(parseEnvFileExports("export A=1\nB=2\n")).toEqual({ A: "1" });
  });

  test("never throws on garbage input", () => {
    expect(parseEnvFileAssignments(undefined)).toEqual({});
    expect(parseEnvFileAssignments("=novalue\n1BAD=x\n")).toEqual({});
  });
});

describe("daemon-visible Layer-1 resolution", () => {
  test("an env-file CATALYST_CONFIG_FILE pin is the daemon's Layer-1", () => {
    const r = resolveDaemonLayer1Path({ env: {}, execCoreEnvText: "export CATALYST_CONFIG_FILE=/plugin-source/.catalyst/config.json" });
    expect(r).toEqual({ path: "/plugin-source/.catalyst/config.json", source: "exec-core-env-file", pinned: true });
  });

  test("the env-file pin beats an ambient one (the launcher sources the file last)", () => {
    const r = resolveDaemonLayer1Path({ env: { CATALYST_CONFIG_FILE: "/ambient/c.json" }, execCoreEnvText: "export CATALYST_CONFIG_FILE=/file/c.json" });
    expect(r.path).toBe("/file/c.json");
    expect(r.source).toBe("exec-core-env-file");
  });

  test("with no pin, the CATALYST_DIR candidate is used only when it EXISTS", () => {
    const present = resolveDaemonLayer1Path({ catalystDir: "/home/u/catalyst", exists: () => true });
    expect(present).toEqual({ path: "/home/u/catalyst/.catalyst/config.json", source: "catalyst-dir", pinned: true });
  });

  // THE mini BUG: no CATALYST_CONFIG_FILE anywhere and no ~/catalyst/.catalyst/config.json,
  // so the daemon silently falls back to whatever cwd it was launched from.
  test("no pin and no CATALYST_DIR candidate ⇒ UNPINNED (the measured mini state)", () => {
    const r = resolveDaemonLayer1Path({ env: {}, execCoreEnvText: "CATALYST_EXECUTOR=sdk\n", catalystDir: "/home/u/catalyst", exists: () => false });
    expect(r).toEqual({ path: null, source: "daemon-cwd", pinned: false });
  });

  // Codex P2, sharp edge: a BARE CATALYST_CONFIG_FILE satisfies the launcher's
  // `[[ -z "${CATALYST_CONFIG_FILE:-}" ]]` guard (:341) so the auto-pin is SKIPPED,
  // while the nohup'd daemon child never inherits it. The daemon therefore falls
  // through to its own cwd — the operator believes they pinned it, and did not.
  test("a BARE CATALYST_CONFIG_FILE suppresses the auto-pin AND does not reach the daemon", () => {
    const r = resolveDaemonLayer1Path({
      env: {},
      execCoreEnvText: "CATALYST_CONFIG_FILE=/plugin-source/.catalyst/config.json\n",
      catalystDir: "/home/u/catalyst",
      exists: () => true, // the auto-pin candidate EXISTS and is still not used
    });
    expect(r.pinned).toBe(false);
    expect(r.path).toBeNull();
    expect(r.barePinSuppressed).toBe("/plugin-source/.catalyst/config.json");
  });

  test("an EXPORTED pin still wins over the CATALYST_DIR candidate", () => {
    const r = resolveDaemonLayer1Path({
      env: {},
      execCoreEnvText: "export CATALYST_CONFIG_FILE=/pinned/config.json\n",
      catalystDir: "/home/u/catalyst",
      exists: () => true,
    });
    expect(r).toEqual({ path: "/pinned/config.json", source: "exec-core-env-file", pinned: true });
  });
});

// Codex P1: collectConfigDump selected and READ Layer-1 before loading the daemon
// env file, so `daemonLayer1` named the pinned file while every Layer-1-derived row
// and the fingerprint were computed from the caller's cwd file — the dump
// disagreeing with itself in exactly the per-host-pin scenario it exists to
// diagnose. These tests do real (read-only) I/O over a tmp fixture tree.
describe("collectConfigDump — Layer-1 is read from the DAEMON's resolution", () => {
  const dirs = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });
  function tree() {
    const root = mkdtempSync(resolve(tmpdir(), "config-dump-collect-"));
    dirs.push(root);
    const home = resolve(root, "home");
    const cwd = resolve(root, "cwd");
    const pinned = resolve(root, "pinned");
    mkdirSync(resolve(home, ".config", "catalyst"), { recursive: true });
    mkdirSync(resolve(cwd, ".catalyst"), { recursive: true });
    mkdirSync(resolve(pinned, ".catalyst"), { recursive: true });
    // Two DIFFERENT Layer-1 files, disagreeing on a genuinely Layer-1-backed key.
    // Under the old ordering the dump NAMED the pinned file while reading cwd's, so
    // this row would read "phase-agents" — the caller's answer, not the daemon's.
    writeFileSync(
      resolve(pinned, ".catalyst", "config.json"),
      JSON.stringify({ catalyst: { orchestration: { dispatchMode: "execution-core" } } }),
    );
    writeFileSync(
      resolve(cwd, ".catalyst", "config.json"),
      JSON.stringify({ catalyst: { orchestration: { dispatchMode: "phase-agents" } } }),
    );
    return { root, home, cwd, pinnedPath: resolve(pinned, ".catalyst", "config.json") };
  }

  test("an exported env-file pin drives the ROWS and the fingerprint, not just the label", () => {
    const { home, cwd, pinnedPath } = tree();
    writeFileSync(
      resolve(home, ".config", "catalyst", "execution-core.env"),
      `export CATALYST_CONFIG_FILE=${pinnedPath}\n`,
    );
    const d = collectConfigDump({ env: { HOME: home }, cwd, now: new Date(0) });

    expect(d.daemonLayer1.pinned).toBe(true);
    expect(d.daemonLayer1.path).toBe(pinnedPath);
    // The label and the bytes now agree...
    expect(d.layer1.path).toBe(pinnedPath);
    // ...so the row reflects the file the DAEMON reads, not the caller's cwd.
    expect(row(d, "catalyst.orchestration.dispatchMode").value).toBe("execution-core");
  });

  test("with no pin, Layer-1 still falls back to the caller's cwd and says it is unpinned", () => {
    const { home, cwd } = tree();
    writeFileSync(resolve(home, ".config", "catalyst", "execution-core.env"), "export CATALYST_EXECUTOR=sdk\n");
    const d = collectConfigDump({ env: { HOME: home }, cwd, now: new Date(0) });
    expect(d.daemonLayer1.pinned).toBe(false);
    expect(d.layer1.path).toBe(resolve(cwd, ".catalyst", "config.json"));
    expect(row(d, "catalyst.orchestration.dispatchMode").value).toBe("phase-agents");
  });

  test("bareKeys names env-file keys the daemon never receives", () => {
    const { home, cwd } = tree();
    writeFileSync(
      resolve(home, ".config", "catalyst", "execution-core.env"),
      "export CATALYST_EXECUTOR=sdk\nCATALYST_STALL_JANITOR=enforce\n",
    );
    const d = collectConfigDump({ env: { HOME: home }, cwd, now: new Date(0) });
    expect(d.execCoreEnv.keys).toContain("CATALYST_STALL_JANITOR");
    expect(d.execCoreEnv.bareKeys).toEqual(["CATALYST_STALL_JANITOR"]);
    // ...and the bare override is NOT reported as in force.
    expect(row(d, "catalyst.stallJanitor.mode").value).toBe("shadow");
  });
});

describe("provenance — mode knobs", () => {
  const L2 = JSON.stringify({ catalyst: { stallJanitor: { mode: "shadow" } } });

  test("default when neither env nor config supplies a mode", () => {
    const r = row(dump(), "catalyst.stallJanitor.mode");
    expect(r.value).toBe("shadow"); // readStallJanitorConfig's conservative default
    expect(r.provenance).toBe(PROVENANCE.DEFAULT);
    expect(r.layer).toBeNull();
  });

  test("Layer-2 wins over the default and is labelled with its layer", () => {
    const r = row(dump({ layer2Text: JSON.stringify({ catalyst: { unstuckSweep: { mode: "enforce" } } }) }), "catalyst.unstuckSweep.mode");
    expect(r.value).toBe("enforce");
    expect(r.provenance).toBe(PROVENANCE.CONFIG);
    expect(r.layer).toBe("layer2");
  });

  test("env beats Layer-2 and names the winning variable", () => {
    const r = row(dump({ env: { CATALYST_STALL_JANITOR: "enforce" }, layer2Text: L2 }), "catalyst.stallJanitor.mode");
    expect(r.value).toBe("enforce");
    expect(r.provenance).toBe(PROVENANCE.ENV);
    expect(r.envVar).toBe("CATALYST_STALL_JANITOR");
  });

  test('the "0" kill-switch is an env override resolving to off', () => {
    const r = row(dump({ env: { CATALYST_STALL_JANITOR: "0" } }), "catalyst.stallJanitor.mode");
    expect(r.value).toBe("off");
    expect(r.provenance).toBe(PROVENANCE.ENV);
  });

  test("an env value that is not a valid mode does NOT win (falls through to config/default)", () => {
    const r = row(dump({ env: { CATALYST_STALL_JANITOR: "enfroce" }, layer2Text: L2 }), "catalyst.stallJanitor.mode");
    expect(r.provenance).toBe(PROVENANCE.CONFIG);
    expect(r.value).toBe("shadow");
  });

  // THE MEASURED DIVERGENCE: an env-file-only override is invisible to a naive
  // process.env read, but it is what the daemon actually runs with.
  test("an env-file-only override is reported as an env override (the mini vs mini-2 gap)", () => {
    const d = dump({ execCoreEnvText: "export CATALYST_UNSTUCK_SWEEP=enforce\nexport CATALYST_STALL_JANITOR=enforce\n" });
    expect(row(d, "catalyst.unstuckSweep.mode").value).toBe("enforce");
    expect(row(d, "catalyst.unstuckSweep.mode").provenance).toBe(PROVENANCE.ENV);
    expect(row(d, "catalyst.stallJanitor.mode").value).toBe("enforce");
  });
});

describe("provenance — beliefs flags, merges, and plain values", () => {
  test('a beliefs flag reads env "1"/"0" first, then the Layer-2 boolean', () => {
    expect(row(dump({ env: { CATALYST_DIAGNOSTICIAN: "1" } }), "catalyst.governance.diagnostician")).toMatchObject({
      value: true,
      provenance: PROVENANCE.ENV,
    });
    expect(
      row(dump({ layer2Text: JSON.stringify({ catalyst: { governance: { diagnostician: true } } }) }), "catalyst.governance.diagnostician"),
    ).toMatchObject({ value: true, provenance: PROVENANCE.CONFIG, layer: "layer2" });
    expect(row(dump(), "catalyst.governance.diagnostician")).toMatchObject({ value: false, provenance: PROVENANCE.DEFAULT });
  });

  test("executionCore concurrency: a positive-int Layer-2 wins per field over Layer-1", () => {
    const d = dump({
      layer1Text: JSON.stringify({ catalyst: { orchestration: { executionCore: { maxParallel: 4, minParallel: 1 } } } }),
      layer2Text: JSON.stringify({ catalyst: { orchestration: { executionCore: { maxParallel: 6 } } } }),
    });
    expect(row(d, "catalyst.orchestration.executionCore.maxParallel")).toMatchObject({ value: 6, layer: "layer2" });
    // minParallel is absent from Layer-2 → the Layer-1 seed survives.
    expect(row(d, "catalyst.orchestration.executionCore.minParallel")).toMatchObject({ value: 1, layer: "layer1" });
  });

  test("a malformed (non-positive-int) Layer-2 never caps a healthy Layer-1", () => {
    const d = dump({
      layer1Text: JSON.stringify({ catalyst: { orchestration: { executionCore: { maxParallel: 4 } } } }),
      layer2Text: JSON.stringify({ catalyst: { orchestration: { executionCore: { maxParallel: 0 } } } }),
    });
    expect(row(d, "catalyst.orchestration.executionCore.maxParallel")).toMatchObject({ value: 4, layer: "layer1" });
  });

  test("a Layer-1-only knob is reported from layer1", () => {
    const d = dump({ layer1Text: JSON.stringify({ catalyst: { orchestration: { dispatchMode: "phase-agents" } } }) });
    expect(row(d, "catalyst.orchestration.dispatchMode")).toMatchObject({ value: "phase-agents", layer: "layer1" });
  });

  // ── CTL-1214 remediation: the bash-read ladder + the derived setpoint ────────
  test("a layer1-first knob reports LAYER1 as the winner when both layers carry it", () => {
    const d = dump({
      layer1Text: JSON.stringify({ catalyst: { orchestration: { dispatchMode: "phase-agents" } } }),
      layer2Text: JSON.stringify({ catalyst: { orchestration: { dispatchMode: "oneshot-legacy" } } }),
    });
    // The bash readers consult Layer-2 only when Layer-1 is silent, so naming
    // layer2 here would send an operator to edit a file that changes nothing.
    expect(row(d, "catalyst.orchestration.dispatchMode")).toMatchObject({
      value: "phase-agents",
      layer: "layer1",
    });
    // Positive control on the SAME pair of layers: a Layer-2-wins row built from
    // identical inputs resolves the other way, so the assertion above is a
    // property of the ladder and not of the fixture.
    const control = dump({
      layer1Text: JSON.stringify({ catalyst: { orchestration: { reconcile: { mode: "notify" } } } }),
      layer2Text: JSON.stringify({ catalyst: { orchestration: { reconcile: { mode: "apply" } } } }),
    });
    expect(row(control, "catalyst.orchestration.reconcile.mode")).toMatchObject({ layer: "layer2" });
  });

  test("a layer1-first knob falls back to layer2 when Layer-1 is silent (the slimmed repo)", () => {
    const d = dump({
      layer1Text: JSON.stringify({ catalyst: { projectKey: "p" } }),
      layer2Text: JSON.stringify({ catalyst: { sweep: { intervalHours: 1 } } }),
    });
    expect(row(d, "catalyst.sweep.intervalHours")).toMatchObject({ value: 1, layer: "layer2" });
    // …and to the code default when neither layer carries it. 2, not 1: this is
    // the halved-cadence trap the relocation had to keep visible.
    expect(row(dump(), "catalyst.sweep.intervalHours")).toMatchObject({
      value: 2,
      provenance: PROVENANCE.DEFAULT,
    });
  });

  test("the three previously-invisible relocated categories now emit rows", () => {
    const d = dump({
      layer2Text: JSON.stringify({
        catalyst: {
          sweep: { idleHours: 48 },
          feedback: { autoFile: true },
          monitor: { github: { repoColors: { "a/b": "green" } } },
        },
      }),
    });
    // AC-2's before/after comparison is only as good as the rows it covers.
    expect(row(d, "catalyst.sweep.idleHours")).toMatchObject({ value: 48 });
    expect(row(d, "catalyst.feedback.autoFile")).toMatchObject({ value: true });
    expect(row(d, "catalyst.monitor.github.repoColors")).toMatchObject({ value: { "a/b": "green" } });
    expect(row(d, "catalyst.orchestration.reconcile.intervalSeconds")).toBeDefined();
  });

  test("the DERIVED setpoint row moves when the raw rows do not — the AC-2 blind spot", () => {
    const layer2Text = JSON.stringify({ catalyst: { orchestration: { executionCore: { maxParallel: 9 } } } });
    // BEFORE: a fat Layer-1 supplies maxParallel, so the setpoint resolves to 4.
    const before = dump({
      layer1Text: JSON.stringify({ catalyst: { orchestration: { executionCore: { maxParallel: 4 } } } }),
      layer2Text,
    });
    expect(row(before, "catalyst.orchestration.executionCore.targetParallel.resolved")).toMatchObject({
      value: 4,
      layer: "merged",
    });

    // AFTER: Layer-1 slimmed, no targetParallel seeded. The setpoint is GONE.
    const after = dump({ layer1Text: JSON.stringify({ catalyst: { projectKey: "p" } }), layer2Text });
    expect(row(after, "catalyst.orchestration.executionCore.targetParallel.resolved")).toMatchObject({
      value: null,
      provenance: PROVENANCE.DEFAULT,
    });

    // ⚠️ The whole point: the RAW targetParallel row is identical across the two,
    // so the before/after comparison reported zero differences over this change.
    expect(row(before, "catalyst.orchestration.executionCore.targetParallel").value).toEqual(
      row(after, "catalyst.orchestration.executionCore.targetParallel").value,
    );
  });

  test("an explicit Layer-2 targetParallel wins the derived row over Layer-1 maxParallel", () => {
    const d = dump({
      layer1Text: JSON.stringify({ catalyst: { orchestration: { executionCore: { maxParallel: 4 } } } }),
      layer2Text: JSON.stringify({ catalyst: { orchestration: { executionCore: { targetParallel: 7 } } } }),
    });
    expect(row(d, "catalyst.orchestration.executionCore.targetParallel.resolved")).toMatchObject({ value: 7 });
  });

  test("a Layer-2-only knob reports layer2 and is overridden by its env var", () => {
    const l2 = JSON.stringify({ catalyst: { node: { class: "monitor" } } });
    expect(row(dump({ layer2Text: l2 }), "catalyst.node.class")).toMatchObject({ value: "monitor", layer: "layer2" });
    expect(row(dump({ layer2Text: l2, env: { CATALYST_NODE_CLASS: "worker" } }), "catalyst.node.class")).toMatchObject({
      value: "worker",
      provenance: PROVENANCE.ENV,
    });
  });
});

describe("layer health is reported honestly", () => {
  test("an absent Layer-1 is present:false, and every row falls to its default", () => {
    const d = dump();
    expect(d.layer1).toMatchObject({ present: false, parsed: false, hasOrchestration: false });
    expect(d.rows.every((r) => r.provenance === PROVENANCE.DEFAULT)).toBe(true);
  });

  test("a MALFORMED Layer-1 is present-but-unparsed, never a crash", () => {
    const d = dump({ layer1Text: "{ not json" });
    expect(d.layer1).toMatchObject({ present: true, parsed: false, hasOrchestration: false });
  });

  // The single most diagnostic Layer-1 fact measured on the live fleet: mini's
  // daemon reads a config with NO orchestration stanza, so every Layer-1-driven
  // feature runs on defaults with nothing surfaced anywhere.
  test("hasOrchestration distinguishes a real config from one missing the stanza", () => {
    expect(dump({ layer1Text: JSON.stringify({ catalyst: { monitor: {} } }) }).layer1.hasOrchestration).toBe(false);
    expect(dump({ layer1Text: JSON.stringify({ catalyst: { orchestration: {} } }) }).layer1.hasOrchestration).toBe(true);
  });

  test("the env-file KEY SET is reported (names only) — itself a divergence signal", () => {
    const d = dump({ execCoreEnvText: "CATALYST_STALL_JANITOR=enforce\nLINEAR_API_TOKEN=lin_api_supersecret\n" });
    expect(d.execCoreEnv.keys).toEqual(["CATALYST_STALL_JANITOR", "LINEAR_API_TOKEN"]);
    expect(JSON.stringify(d)).not.toContain("lin_api_supersecret");
  });
});

describe("secrets are reported as presence only, never as values", () => {
  const SECRET = "lin_api_THIS_MUST_NEVER_APPEAR";

  test("a secret row reports set/unset", () => {
    expect(row(dump(), "secrets.LINEAR_API_TOKEN")).toMatchObject({ value: "unset", secret: true });
    expect(row(dump({ env: { LINEAR_API_TOKEN: SECRET } }), "secrets.LINEAR_API_TOKEN")).toMatchObject({ value: "set", secret: true });
  });

  test("no registered secret's value appears in EITHER renderer", () => {
    const d = dump({
      env: { LINEAR_API_TOKEN: SECRET, CATALYST_WORKFLOW_GITHUB_TOKEN: "ghp_secret", CATALYST_CLOUD_TOKEN: "cloud_secret", GROQ_API_KEY: "gsk_secret" },
      execCoreEnvText: `LINEAR_API_TOKEN=${SECRET}\n`,
    });
    for (const text of [renderJson(d), renderHuman(d)]) {
      for (const leak of [SECRET, "ghp_secret", "cloud_secret", "gsk_secret"]) {
        expect(text).not.toContain(leak);
      }
    }
  });

  test("every registry row whose env var LOOKS credential-shaped is marked secret", () => {
    for (const r of CONFIG_KEYS) {
      const credentialShaped = (r.env ?? []).some((n) => /TOKEN|SECRET|PASSWORD|_KEY$/.test(n));
      if (credentialShaped) expect(r.secret).toBe(true);
    }
  });

  test("no secret row declares a config-file key (there is no path for a value to arrive)", () => {
    for (const r of CONFIG_KEYS.filter((x) => x.secret)) {
      expect(r.layer1).toBeNull();
      expect(r.layer2).toBeNull();
    }
  });
});

describe("fingerprint", () => {
  test("is stable across JSON key order and whitespace", () => {
    const a = dump({ layer2Text: '{"catalyst":{"stallJanitor":{"mode":"enforce"},"boardHealth":{"mode":"shadow"}}}' });
    const b = dump({ layer2Text: '{\n  "catalyst": {\n    "boardHealth": { "mode": "shadow" },\n    "stallJanitor": { "mode": "enforce" }\n  }\n}\n' });
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  test("is host- and timestamp-independent (so two hosts are comparable)", () => {
    const a = dump({ host: "mini", generatedAt: "2026-01-01T00:00:00.000Z" });
    const b = dump({ host: "mini-2", generatedAt: "2026-12-31T23:59:59.000Z" });
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  test("changes when a VALUE changes", () => {
    expect(dump().fingerprint).not.toBe(dump({ env: { CATALYST_STALL_JANITOR: "enforce" } }).fingerprint);
  });

  test("changes when only the LAYER changes, at an identical value", () => {
    const viaEnv = dump({ env: { CATALYST_UNSTUCK_SWEEP: "enforce" } });
    const viaCfg = dump({ layer2Text: JSON.stringify({ catalyst: { unstuckSweep: { mode: "enforce" } } }) });
    expect(row(viaEnv, "catalyst.unstuckSweep.mode").value).toBe(row(viaCfg, "catalyst.unstuckSweep.mode").value);
    expect(viaEnv.fingerprint).not.toBe(viaCfg.fingerprint);
  });

  // The headline use case: the two live worker hosts must NOT fingerprint alike.
  test("the measured mini / mini-2 divergence produces different fingerprints", () => {
    const mini = dump({ execCoreEnvText: "export CATALYST_STALL_JANITOR=enforce\nexport CATALYST_UNSTUCK_SWEEP=enforce\nexport CATALYST_DEAD_DOC_WORKER_RECLAIM=enforce\n" });
    const mini2 = dump({ execCoreEnvText: "export CATALYST_CONFIG_FILE=/plugin-source/.catalyst/config.json\n" });
    expect(mini.fingerprint).not.toBe(mini2.fingerprint);
  });
});

describe("shape + renderers", () => {
  test("the dump carries a schema id and one row per registry key", () => {
    const d = dump();
    expect(d.schema).toBe(DUMP_SCHEMA);
    expect(d.rows).toHaveLength(CONFIG_KEYS.length);
  });

  test("--json output round-trips", () => {
    expect(JSON.parse(renderJson(dump())).fingerprint).toBe(dump().fingerprint);
  });

  test("the human renderer names the unpinned daemon Layer-1 loudly", () => {
    const text = renderHuman(dump({ daemonLayer1: { path: null, source: "daemon-cwd", pinned: false } }));
    expect(text).toContain("UNPINNED");
  });

  test("getPath never throws on a missing ancestor", () => {
    expect(getPath(null, "a.b")).toBeUndefined();
    expect(getPath({ a: 1 }, "a.b")).toBeUndefined();
  });

  test("resolveRow is pure — no ambient env or file reads leak in", () => {
    const r = CONFIG_KEYS.find((x) => x.key === "catalyst.stallJanitor.mode");
    expect(resolveRow(r, {})).toMatchObject({ value: "shadow", provenance: PROVENANCE.DEFAULT });
  });

  test("fingerprintRows is order-insensitive over the row array", () => {
    const rows = dump().rows;
    expect(fingerprintRows(rows)).toBe(fingerprintRows([...rows].reverse()));
  });
});

// ─── DRIFT GUARDS ────────────────────────────────────────────────────────────
// The dump describes ladders it does not own. These tests pin the description to
// the source: rename an env var or a config key in a reader and THIS breaks,
// instead of the dump silently reporting a knob nobody reads any more.

describe("registry drift guards", () => {
  const SOURCES = [
    "execution-core/config.mjs",
    "execution-core/scheduler.mjs",
    "execution-core/daemon.mjs",
    "execution-core/worktree-refresh-timer.mjs",
    "execution-core/linear-reconcile-timer.mjs",
    "lib/deployment-mode.mjs",
    "lib/draft-pr.sh",
    "lib/secret-contract.mjs",
    // CTL-1214: resolveTargetSetpoint (and with it the only mention of
    // `targetParallel`) moved OUT of scheduler.mjs into this zero-import leaf, so
    // that `catalyst doctor` — which runs under bare Node and cannot load
    // scheduler.mjs's bun:sqlite graph — can grade the setpoint through the same
    // ladder instead of a second copy. This guard caught the move, which is what
    // it is for: the corpus has to follow the reader.
    "lib/autotune-setpoint.mjs",
    "orchestrate-register-interests.sh",
    // CTL-1214 remediation: the dump now carries the three relocated categories
    // read by BASH (sweep.*, feedback.*) and by orch-monitor (repoColors), so the
    // corpus has to carry their readers too — otherwise the leaf guard fails on
    // rows whose reader is real but unrepresented, and the honest fix would look
    // like deleting the rows. The corpus follows the reader, per the note above.
    "orphan-sweep.sh",
    "feedback-consent.sh",
    "file-feedback.sh",
    "orch-monitor/lib/monitor-config.ts",
  ]
    .map((p) => {
      try {
        return readFileSync(resolve(SCRIPTS, p), "utf8");
      } catch {
        return "";
      }
    })
    .join("\n");

  test("the source corpus actually loaded (guards against a silently-empty grep)", () => {
    expect(SOURCES.length).toBeGreaterThan(100_000);
  });

  test("every env var named by the registry exists in the source corpus", () => {
    const missing = [];
    for (const r of CONFIG_KEYS) for (const name of r.env ?? []) if (!SOURCES.includes(name)) missing.push(`${r.key} → ${name}`);
    expect(missing).toEqual([]);
  });

  test("every dotted config key's LEAF segment appears in the source corpus", () => {
    // Full dotted paths are written with optional chaining in the readers
    // (`?.catalyst?.stallJanitor`), so the leaf + its parent are the honest
    // greppable unit.
    const missing = [];
    for (const r of CONFIG_KEYS) {
      for (const dotted of [r.layer1, r.layer2].filter(Boolean)) {
        const parts = dotted.split(".");
        const leaf = parts[parts.length - 1];
        const parent = parts[parts.length - 2];
        if (!SOURCES.includes(leaf)) missing.push(`${r.key} → leaf ${leaf}`);
        else if (parent && !SOURCES.includes(parent)) missing.push(`${r.key} → parent ${parent}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test("registry keys are unique and the registry is frozen", () => {
    expect(new Set(CONFIG_KEYS.map((r) => r.key)).size).toBe(CONFIG_KEYS.length);
    expect(Object.isFrozen(CONFIG_KEYS)).toBe(true);
    expect(CONFIG_KEYS.every((r) => Object.isFrozen(r))).toBe(true);
  });

  test("every mode row shares the reader's OWN mode Set (not a copy)", () => {
    for (const r of CONFIG_KEYS.filter((x) => x.kind === "mode")) {
      expect(r.modes).toBeInstanceOf(Set);
      expect(r.modes.size).toBeGreaterThan(0);
    }
  });

  test("this module is importable under bare Node (doctor's runtime): no bun: imports in its graph", () => {
    const self = readFileSync(resolve(HERE, "config-dump.mjs"), "utf8");
    expect(self).not.toContain('from "bun:');
  });

  // The fingerprint separator is U+0000 (it cannot occur in a key or a mode
  // string), but it must be written in SOURCE as the escape sequence, never as a
  // raw byte: a literal NUL makes the whole file "binary" to grep, `git diff`, and
  // review tooling — a `grep` for any symbol in it then returns NOTHING, silently.
  // (This bit during development; the separator's runtime value is unchanged.)
  // The needle is built at runtime so this test file cannot re-introduce the bug
  // it is guarding against.
  test("both source files are plain text — no raw NUL byte (grep/diff would treat them as binary)", () => {
    const NUL = String.fromCharCode(0);
    for (const f of ["config-dump.mjs", "config-dump.test.mjs"]) {
      expect(readFileSync(resolve(HERE, f), "utf8").includes(NUL)).toBe(false);
    }
    // ...while the fingerprint stream still uses NUL as its separator.
    expect(readFileSync(resolve(HERE, "config-dump.mjs"), "utf8")).toContain("\\u0000");
  });
});

// ─── CTL-1214: the merged Layer-2 + the relocated rows ───────────────────────
describe("CTL-1214 — merged Layer-2 and relocated rows", () => {
  const l1 = JSON.stringify({ catalyst: { projectKey: "p", schemaVersion: 1 } });

  test("a value in node.json resolves, with layer2 provenance", () => {
    const d = dumpConfig({
      layer1Text: l1,
      layer2Text: JSON.stringify({ catalyst: {} }),
      nodeText: JSON.stringify({
        catalyst: { orchestration: { dispatchMode: "phase-agents" } },
      }),
    });
    const row = d.rows.find((r) => r.key === "catalyst.orchestration.dispatchMode");
    expect(row.value).toBe("phase-agents");
    expect(row.layer).toBe("layer2");
    // The sharp half: NOT the silent default a Layer-1-only read would report.
    expect(row.value).not.toBe("oneshot-legacy");
  });

  test("a slimmed Layer-1 with NO node.json falls to the default (negative control)", () => {
    const d = dumpConfig({ layer1Text: l1, layer2Text: JSON.stringify({ catalyst: {} }) });
    const row = d.rows.find((r) => r.key === "catalyst.orchestration.dispatchMode");
    expect(row.value).toBe("oneshot-legacy");
    expect(row.provenance).toBe("default");
  });

  test("cluster-secrets.json outranks node.json, node.json outranks config.json", () => {
    const mk = (v) => JSON.stringify({ catalyst: { orchestration: { dispatchMode: v } } });
    const pick = (d) => d.rows.find((r) => r.key === "catalyst.orchestration.dispatchMode").value;
    expect(pick(dumpConfig({ layer1Text: l1, layer2Text: mk("oneshot-legacy") }))).toBe("oneshot-legacy");
    expect(
      pick(dumpConfig({ layer1Text: l1, layer2Text: mk("oneshot-legacy"), nodeText: mk("phase-agents") })),
    ).toBe("phase-agents");
    expect(
      pick(
        dumpConfig({
          layer1Text: l1,
          layer2Text: mk("oneshot-legacy"),
          nodeText: mk("phase-agents"),
          clusterSecretsText: mk("execution-core"),
        }),
      ),
    ).toBe("execution-core");
  });

  test("the Layer-2 merge is DEEP, not a replace", () => {
    const d = dumpConfig({
      layer1Text: l1,
      layer2Text: JSON.stringify({
        catalyst: { orchestration: { executionCore: { maxParallel: 4 } } },
      }),
      nodeText: JSON.stringify({
        catalyst: { orchestration: { executionCore: { minParallel: 1 } } },
      }),
    });
    const get = (k) => d.rows.find((r) => r.key === k).value;
    expect(get("catalyst.orchestration.executionCore.maxParallel")).toBe(4);
    expect(get("catalyst.orchestration.executionCore.minParallel")).toBe(1);
  });

  test("a malformed sibling is layer-ABSENT, never fatal", () => {
    const d = dumpConfig({
      layer1Text: l1,
      layer2Text: JSON.stringify({ catalyst: { orchestration: { dispatchMode: "phase-agents" } } }),
      nodeText: "{ not json at all",
    });
    expect(d.rows.find((r) => r.key === "catalyst.orchestration.dispatchMode").value).toBe("phase-agents");
    expect(d.layer2.node.parsed).toBe(false);
    expect(d.layer2.node.present).toBe(true);
  });

  test("the dead eligibleQuery.status row is GONE from CONFIG_KEYS", () => {
    const keys = CONFIG_KEYS.map((r) => r.key);
    expect(keys).not.toContain("catalyst.orchestration.executionCore.eligibleQuery.status");
    // Positive control: the row set is otherwise intact and still names its
    // orchestration neighbours, so "not contains" is not an empty-list artifact.
    expect(keys).toContain("catalyst.orchestration.dispatchMode");
    expect(keys).toContain("catalyst.orchestration.executor");
    expect(keys.length).toBeGreaterThan(20);
  });

  test("the four relocated row families declare a layer2 source", () => {
    const byKey = Object.fromEntries(CONFIG_KEYS.map((r) => [r.key, r]));
    for (const k of [
      "catalyst.orchestration.dispatchMode",
      "catalyst.orchestration.reconcile.mode",
      "catalyst.orchestration.executionCore.maxParallel",
      "catalyst.orchestration.executionCore.minParallel",
      "catalyst.orchestration.executionCore.maxParallelCeiling",
      "catalyst.orchestration.worktreeRefresh.enabled",
      "catalyst.orchestration.worktreeRefresh.intervalSeconds",
    ]) {
      expect(byKey[k]?.layer2).toBeTruthy();
    }
    // D6 negative control: the NON-relocating orchestration keys must NOT have
    // grown a layer2 source — they are genuinely Layer-1.
    // (some rows declare an explicit `layer2: null`, so the assertion is
    // "declares no Layer-2 source", not "the property is absent")
    expect(byKey["catalyst.orchestration.executor"].layer2 ?? null).toBeNull();
    expect(byKey["catalyst.orchestration.executorByPhase"].layer2 ?? null).toBeNull();
    expect(byKey["catalyst.orchestration.draftPr.enabled"].layer2 ?? null).toBeNull();
  });
});
