// index-drop-wiring.test.ts — CTL-1818. The two lines in index.ts that WIRE the drop surface
// into the daemon, held load-bearing by BEHAVIOUR rather than by inspection.
//
// The unit suites next door exercise the drop surface by calling into it directly —
// `resolveDropSurfaceConfig(...)` and `evaluateDropSurface({ ...io })` — so they pass whether or
// not index.ts ever calls either one. Measured before this file existed: deleting each wiring
// line in turn left the whole otel-forward suite at 236 pass / 0 fail. That is the
// "tested the pure function, not the gate in front of it" hole, and these two probes close it:
//
//   index.ts  `configureDropSurface(cfg.otlp.dropSurface)` — without it the documented
//     `forwarders.otlp.dropSurface` config layer is DEAD: the surface runs on env + the frozen
//     defaults forever while website/src/content/docs/reference/configuration.md declares that
//     layer authoritative, and an operator who raises the threshold on a noisy host is ignored.
//   index.ts  `evaluateDropSurface()` on the 30 s lag tick — without it a host that recovered
//     latches `alert.raised: true` FOREVER, in memory and in the marker file. The clear branch in
//     lib/drop-surface.ts is reachable from this tick and from nothing else.
//
// ── Why a SUBPROCESS ──────────────────────────────────────────────────────────────────────────
// Both facts are module-scope facts. `configureDropSurface` runs on `import` of index.ts, not on
// any call, and `bun test` shares ONE module registry across every file in the run — so an
// in-process import would observe whichever env/cwd the first importing test file happened to
// leave behind, and would be silently order-dependent. A spawned probe with a pinned
// CATALYST_DIR / CATALYST_EVENTS_DIR / CATALYST_CONFIG_PATH is deterministic and hermetic:
// nothing it writes can land in the real ~/catalyst, and nothing in the developer's shell can
// stand in for the config tier under test. (Same shape as execution-core's
// config-pino-fallback.test.mjs, which spawns probes for the same module-load reason.)
//
// Run: cd plugins/dev/scripts/otel-forward && bun test index-drop-wiring.test.ts
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DROP_SURFACE_DEFAULTS } from "./lib/drop-surface.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX_TS = resolve(HERE, "index.ts");
const DROP_SURFACE_TS = resolve(HERE, "lib/drop-surface.ts");

// Deliberately unlike DROP_SURFACE_DEFAULTS (300_000 / 1_000 / 600_000) in ALL THREE fields, so
// "the config file reached the surface" can never be confused with "the default happened to
// match". Every value is also inside its own validity floor, so the resolver keeps it verbatim.
const FILE_CFG = { windowMs: 111_000, thresholdRecords: 222, sustainMs: 333_000 };

// The alert fixture, applied INSIDE the probe AFTER the config observation is captured, so the
// two assertions stay independent: deleting the configure line must fail probe (1) alone, and
// deleting the tick call must fail probe (2) alone.
const ALERT_CFG = { windowMs: 60_000, thresholdRecords: 100, sustainMs: 30_000 };

// Written to a temp dir and run by the same bun that runs this suite. It imports index.ts the way
// production does: module scope executes, while the daemon loop behind `if (import.meta.main)`
// does not, because the entry point is the probe rather than index.ts.
const PROBE_SRC = `
import { readFileSync } from "node:fs";

const idx = await import(process.env.PROBE_INDEX);
const ds = await import(process.env.PROBE_DROP_SURFACE);

// (1) What index.ts applied to the surface at import time. Nothing has been called yet — if the
// wiring line is gone this is the frozen default set, not the config file's block.
const applied = ds.dropSurfaceSnapshot().config;

// (2) Latch a sustained-loss alert on the surface, then run ONE tick body and watch it clear.
// The injected clock is what makes this deterministic: the two drops sit at t=1s/t=40s (39s of
// sustained breach against a 30s sustain window), and the tick then evaluates at the real
// Date.now(), decades later, so the rolling window is provably drained rather than merely quiet.
ds.resetDropSurfaceForTest();
ds.configureDropSurface(JSON.parse(process.env.PROBE_ALERT_CFG));
const quiet = { warn() {}, error() {}, info() {} };
ds.recordDrop("aged", 150, { log: quiet, now: () => 1000 });
ds.recordDrop("aged", 150, { log: quiet, now: () => 40000 });

const markerBefore = JSON.parse(readFileSync(ds.getDropMarkerPath(), "utf8"));
const raisedBeforeTick = ds.dropSurfaceSnapshot().alertRaised;

idx.emitLag();

const markerAfter = JSON.parse(readFileSync(ds.getDropMarkerPath(), "utf8"));
const raisedAfterTick = ds.dropSurfaceSnapshot().alertRaised;

process.stdout.write("PROBE_RESULT " + JSON.stringify({
  applied,
  raisedBeforeTick,
  raisedAfterTick,
  markerRaisedBeforeTick: markerBefore.alert.raised,
  markerRaisedAfterTick: markerAfter.alert.raised,
}) + "\\n");
`;

interface ProbeResult {
  applied: { windowMs: number; thresholdRecords: number; sustainMs: number };
  raisedBeforeTick: boolean;
  raisedAfterTick: boolean;
  markerRaisedBeforeTick: boolean;
  markerRaisedAfterTick: boolean;
}

let dir = "";
let status: number | null = null;
let stderr = "";
let parsed: ProbeResult | null = null;

/** Fails LOUDLY with the probe's own stderr rather than throwing an opaque property error. */
function probe(): ProbeResult {
  if (!parsed) throw new Error(`probe produced no PROBE_RESULT (status=${status})\n${stderr}`);
  return parsed;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "ctl1818-wiring-"));
  const configPath = join(dir, "config-ctl1818-probe.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      catalyst: {
        projectKey: "ctl1818-probe",
        // OTLP stays disabled: the probe is about the drop-surface wiring, and a constructed
        // sender would be dead weight (no endpoint, nothing to flush).
        observability: { forwarders: { otlp: { enabled: false, dropSurface: FILE_CFG } } },
      },
    }),
  );
  const probePath = join(dir, "probe.ts");
  writeFileSync(probePath, PROBE_SRC);

  // Built from scratch rather than spread over process.env, so a CATALYST_FORWARD_DROP_* left in
  // the developer's shell cannot stand in for the config-file tier this probe is measuring, and
  // an OTLP endpoint in the environment cannot make the tick's memory gauge post real samples.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    CATALYST_DIR: dir,
    CATALYST_EVENTS_DIR: join(dir, "events"),
    CATALYST_CONFIG_PATH: configPath,
    LOG_LEVEL: "silent",
    PROBE_INDEX: INDEX_TS,
    PROBE_DROP_SURFACE: DROP_SURFACE_TS,
    PROBE_ALERT_CFG: JSON.stringify(ALERT_CFG),
  };

  const run = spawnSync(process.execPath, [probePath], {
    cwd: HERE,
    env,
    encoding: "utf8",
    timeout: 60_000,
  });
  status = run.status;
  stderr = run.stderr ?? "";
  // The daemon logs on its own logger, so PROBE_RESULT is picked out by marker rather than by
  // assuming it is the only line on stdout.
  const line = (run.stdout ?? "").split("\n").find((l) => l.startsWith("PROBE_RESULT "));
  parsed = line ? (JSON.parse(line.slice("PROBE_RESULT ".length)) as ProbeResult) : null;
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("index.ts wires the drop surface into the daemon (CTL-1818)", () => {
  test("the probe imports the daemon cleanly and reports", () => {
    // Guards the two assertions below against the vacuous pass: a probe that crashed on import
    // must read as a failure here, not as an absent surface change somewhere downstream.
    expect(stderr).not.toContain("error:");
    expect(status).toBe(0);
    expect(parsed).not.toBeNull();
  });

  test("the forwarders.otlp.dropSurface config layer reaches the surface on import", () => {
    // index.ts `configureDropSurface(cfg.otlp.dropSurface)`. Delete it and the surface answers
    // with the frozen defaults instead — the documented config layer silently does nothing.
    expect(probe().applied).toEqual(FILE_CFG);
    expect(probe().applied).not.toEqual({ ...DROP_SURFACE_DEFAULTS });
  });

  test("one lag tick clears a latched sustained-loss alert, in memory and in the marker", () => {
    // index.ts `evaluateDropSurface()` inside emitLag(). The BEFORE assertions are the positive
    // control: they prove the fixture genuinely latched an alert, so `false` afterwards is a real
    // clear rather than an alert that was never raised. Delete the call and the alert stays
    // raised forever — nothing else in the daemon re-evaluates once the drops stop.
    expect(probe().raisedBeforeTick).toBe(true);
    expect(probe().markerRaisedBeforeTick).toBe(true);
    expect(probe().raisedAfterTick).toBe(false);
    expect(probe().markerRaisedAfterTick).toBe(false);
  });
});
