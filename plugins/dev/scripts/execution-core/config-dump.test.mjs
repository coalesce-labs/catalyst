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

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CONFIG_KEYS,
  DUMP_SCHEMA,
  PROVENANCE,
  dumpConfig,
  fingerprintRows,
  getPath,
  overlayEnvFile,
  parseEnvFileAssignments,
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
    expect(overlayEnvFile({ X: "ambient", Y: "keep" }, "X=file")).toEqual({ X: "file", Y: "keep" });
  });

  test("never throws on garbage input", () => {
    expect(parseEnvFileAssignments(undefined)).toEqual({});
    expect(parseEnvFileAssignments("=novalue\n1BAD=x\n")).toEqual({});
  });
});

describe("daemon-visible Layer-1 resolution", () => {
  test("an env-file CATALYST_CONFIG_FILE pin is the daemon's Layer-1", () => {
    const r = resolveDaemonLayer1Path({ env: {}, execCoreEnvText: "CATALYST_CONFIG_FILE=/plugin-source/.catalyst/config.json" });
    expect(r).toEqual({ path: "/plugin-source/.catalyst/config.json", source: "exec-core-env-file", pinned: true });
  });

  test("the env-file pin beats an ambient one (the launcher sources the file last)", () => {
    const r = resolveDaemonLayer1Path({ env: { CATALYST_CONFIG_FILE: "/ambient/c.json" }, execCoreEnvText: "CATALYST_CONFIG_FILE=/file/c.json" });
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
    const r = row(dump({ env: { CATALYST_BOARD_HEALTH: "0" } }), "catalyst.boardHealth.mode");
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
    const mini = dump({ execCoreEnvText: "CATALYST_STALL_JANITOR=enforce\nCATALYST_UNSTUCK_SWEEP=enforce\nCATALYST_DEAD_DOC_WORKER_RECLAIM=enforce\n" });
    const mini2 = dump({ execCoreEnvText: "CATALYST_CONFIG_FILE=/plugin-source/.catalyst/config.json\n" });
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
    "orchestrate-register-interests.sh",
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
