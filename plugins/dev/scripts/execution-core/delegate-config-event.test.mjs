// CTL-1331 — tests for the delegate (async board-health worker) creation-event
// emitter + the runner config reader. Phase A lands these INERT: the emitter
// adds one new `phase.dispatch.enqueued.<TICKET>` producer (dispatch slot is an
// allowed namespace exception) and the config reader gates a runner that does
// not run on its own yet.
//
// Run: cd plugins/dev/scripts/execution-core && bun test delegate-config-event.test.mjs
//
// The dispatch-enqueued round-trip redirects the unified event log via
// CATALYST_DIR (the same seam recovery.test.mjs's CTL-660 dispatch block uses):
// getEventLogPath() resolves under catalystDir(), so pointing CATALYST_DIR at a
// temp dir captures the JSONL line for byte-level assertions.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendDispatchEnqueuedEvent } from "./recovery.mjs";
import {
  readDelegateRunnerConfig,
  readDelegateQueueDepth,
  readGovernanceConfig,
} from "./config.mjs";

// ---------------------------------------------------------------------------
// appendDispatchEnqueuedEvent — round-trip (mirrors the CTL-660 dispatch block)
// ---------------------------------------------------------------------------
describe("appendDispatchEnqueuedEvent (CTL-1331 creation telemetry)", () => {
  let envCatalystDir;
  let prevCatalystDir;
  beforeEach(() => {
    prevCatalystDir = process.env.CATALYST_DIR;
    envCatalystDir = mkdtempSync(join(tmpdir(), "ctl1331-enq-"));
    process.env.CATALYST_DIR = envCatalystDir;
    mkdirSync(join(envCatalystDir, "events"), { recursive: true });
  });
  afterEach(() => {
    if (prevCatalystDir === undefined) delete process.env.CATALYST_DIR;
    else process.env.CATALYST_DIR = prevCatalystDir;
    rmSync(envCatalystDir, { recursive: true, force: true });
  });

  // Read back the single envelope written this test (current UTC month log).
  function readBackEnvelope() {
    const now = new Date();
    const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    const lines = readFileSync(join(envCatalystDir, "events", `${ym}.jsonl`), "utf8")
      .split("\n")
      .filter(Boolean);
    return JSON.parse(lines[lines.length - 1]);
  }

  test("writes a phase.dispatch.enqueued.<TICKET> envelope (INFO, dispatch slot)", () => {
    const ok = appendDispatchEnqueuedEvent({
      orchId: "orch-enq",
      ticket: "CTL-ENQ-1",
      target_phase: "recovery-pass",
      kind: "board-health",
    });
    expect(ok).toBe(true);
    const env = readBackEnvelope();
    // Routes via the dispatch slot (an allowed namespace exception), NOT
    // phase.recovery-pass.* — and the "enqueued" action does not collide with
    // PHASE_EVENT_PATTERN's terminal set (complete|failed|turn-cap-exhausted|skipped).
    expect(env.attributes["event.name"]).toBe("phase.dispatch.enqueued.CTL-ENQ-1");
    expect(env.attributes["event.action"]).toBe("enqueued");
    expect(env.resource["service.name"]).toBe("catalyst.execution-core");
    // body.payload carries the kind + the real phase (target_phase) so operators
    // can filter the enqueue stream.
    expect(env.body.payload.status).toBe("enqueued");
    expect(env.body.payload.target_phase).toBe("recovery-pass");
    expect(env.body.payload.kind).toBe("board-health");
    expect(env.attributes["catalyst.orchestration"]).toBe("orch-enq");
    // CTL-700: healthy lifecycle events emit INFO, not WARN.
    expect(env.severityText).toBe("INFO");
    expect(env.severityNumber).toBe(9);
  });

  test("reason defaults to 'board-health' when omitted", () => {
    const ok = appendDispatchEnqueuedEvent({
      orchId: "orch-enq",
      ticket: "CTL-ENQ-2",
      target_phase: "recovery-pass",
      kind: "board-health",
    });
    expect(ok).toBe(true);
    const env = readBackEnvelope();
    expect(env.body.payload.reason).toBe("board-health");
  });

  test("an explicit reason rides through to the envelope", () => {
    const ok = appendDispatchEnqueuedEvent({
      orchId: "orch-enq",
      ticket: "CTL-ENQ-3",
      target_phase: "recovery-pass",
      kind: "board-health",
      reason: "board anomaly — holistic delegate",
    });
    expect(ok).toBe(true);
    const env = readBackEnvelope();
    expect(env.body.payload.reason).toBe("board anomaly — holistic delegate");
  });

  test("CTL-1023: enqueued carries catalyst.ticket.type from triage.json", () => {
    const orchDir = mkdtempSync(join(tmpdir(), "ctl1331-enq-tt-"));
    mkdirSync(join(orchDir, "workers", "CTL-ENQ-TT"), { recursive: true });
    writeFileSync(
      join(orchDir, "workers", "CTL-ENQ-TT", "triage.json"),
      JSON.stringify({ classification: "bug" }),
    );
    const ok = appendDispatchEnqueuedEvent({
      orchId: "orch-enq",
      orchDir,
      ticket: "CTL-ENQ-TT",
      target_phase: "recovery-pass",
      kind: "board-health",
    });
    expect(ok).toBe(true);
    const env = readBackEnvelope();
    expect(env.attributes["catalyst.ticket.type"]).toBe("bug");
    rmSync(orchDir, { recursive: true, force: true });
  });

  test("catalyst.ticket.type defaults to 'unknown' when no triage.json exists", () => {
    const ok = appendDispatchEnqueuedEvent({
      orchId: "orch-enq",
      orchDir: undefined,
      ticket: "CTL-ENQ-NT",
      target_phase: "recovery-pass",
      kind: "board-health",
    });
    expect(ok).toBe(true);
    const env = readBackEnvelope();
    expect(env.attributes["catalyst.ticket.type"]).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// readDelegateRunnerConfig — defaults, env overrides, board-health coupling
// ---------------------------------------------------------------------------
describe("readDelegateRunnerConfig (CTL-1331)", () => {
  // Pure reader over an injected env object — no global env mutation needed.
  // The board-health coupling reads CATALYST_BOARD_HEALTH from the SAME injected
  // env (so it is deterministic without touching Layer-2). We pass a Layer-2
  // override path that does not exist so readBoardHealthConfig's Layer-2 read
  // resolves to {} and only the injected env decides the mode.
  const NO_L2 = { CATALYST_LAYER2_CONFIG_FILE: "/nonexistent/ctl1331/config.json" };

  test("defaults: interval 15000, intentTtl 1800000; mode 'off' when board-health is shadow (default)", () => {
    const cfg = readDelegateRunnerConfig({ ...NO_L2 });
    expect(cfg.intervalMs).toBe(15000);
    expect(cfg.intentTtlMs).toBe(1800000);
    // board-health defaults to shadow → runner default resolves "off" (inert).
    expect(cfg.mode).toBe("off");
  });

  test("default mode resolves 'on' when board-health is enforce", () => {
    const cfg = readDelegateRunnerConfig({ ...NO_L2, CATALYST_BOARD_HEALTH: "enforce" });
    expect(cfg.mode).toBe("on");
  });

  test("default mode resolves 'off' when board-health is explicitly shadow", () => {
    const cfg = readDelegateRunnerConfig({ ...NO_L2, CATALYST_BOARD_HEALTH: "shadow" });
    expect(cfg.mode).toBe("off");
  });

  test("default mode resolves 'off' when board-health is off", () => {
    const cfg = readDelegateRunnerConfig({ ...NO_L2, CATALYST_BOARD_HEALTH: "off" });
    expect(cfg.mode).toBe("off");
  });

  // CTL-1331 FU-1: the runner must also be ON when the per-item Pass 0r recovery
  // is in enforce (not just board-health) — both paths enqueue recovery-pass
  // intents the runner must drain; if it were off, intents would accumulate and
  // recovery would silently halt. This is the live mini case:
  // board-health=shadow + recovery-pass=enforce → runner ON.
  test("default mode resolves 'on' when recovery-pass is enforce (board-health shadow)", () => {
    const cfg = readDelegateRunnerConfig({
      ...NO_L2,
      CATALYST_BOARD_HEALTH: "shadow",
      CATALYST_RECOVERY_PASS: "enforce",
    });
    expect(cfg.mode).toBe("on");
  });

  test("default mode resolves 'off' when BOTH board-health and recovery-pass are non-enforce", () => {
    const cfg = readDelegateRunnerConfig({
      ...NO_L2,
      CATALYST_BOARD_HEALTH: "shadow",
      CATALYST_RECOVERY_PASS: "shadow",
    });
    expect(cfg.mode).toBe("off");
  });

  test("CATALYST_DELEGATE_RUNNER=off overrides even when recovery-pass is enforce", () => {
    const cfg = readDelegateRunnerConfig({
      ...NO_L2,
      CATALYST_RECOVERY_PASS: "enforce",
      CATALYST_DELEGATE_RUNNER: "off",
    });
    expect(cfg.mode).toBe("off");
  });

  test("CATALYST_DELEGATE_RUNNER=off overrides even when board-health is enforce", () => {
    const cfg = readDelegateRunnerConfig({
      ...NO_L2,
      CATALYST_BOARD_HEALTH: "enforce",
      CATALYST_DELEGATE_RUNNER: "off",
    });
    expect(cfg.mode).toBe("off");
  });

  test("CATALYST_DELEGATE_RUNNER=on overrides even when board-health is shadow", () => {
    const cfg = readDelegateRunnerConfig({
      ...NO_L2,
      CATALYST_BOARD_HEALTH: "shadow",
      CATALYST_DELEGATE_RUNNER: "on",
    });
    expect(cfg.mode).toBe("on");
  });

  test("a garbage CATALYST_DELEGATE_RUNNER value falls back to the board-health coupling", () => {
    const cfg = readDelegateRunnerConfig({
      ...NO_L2,
      CATALYST_BOARD_HEALTH: "enforce",
      CATALYST_DELEGATE_RUNNER: "banana",
    });
    expect(cfg.mode).toBe("on");
  });

  test("CATALYST_DELEGATE_RUNNER_INTERVAL_MS overrides the interval", () => {
    const cfg = readDelegateRunnerConfig({ ...NO_L2, CATALYST_DELEGATE_RUNNER_INTERVAL_MS: "30000" });
    expect(cfg.intervalMs).toBe(30000);
  });

  test("CATALYST_DELEGATE_INTENT_TTL_MS overrides the intent TTL", () => {
    const cfg = readDelegateRunnerConfig({ ...NO_L2, CATALYST_DELEGATE_INTENT_TTL_MS: "600000" });
    expect(cfg.intentTtlMs).toBe(600000);
  });

  test("non-numeric interval / ttl overrides fall back to the defaults", () => {
    const cfg = readDelegateRunnerConfig({
      ...NO_L2,
      CATALYST_DELEGATE_RUNNER_INTERVAL_MS: "not-a-number",
      CATALYST_DELEGATE_INTENT_TTL_MS: "",
    });
    expect(cfg.intervalMs).toBe(15000);
    expect(cfg.intentTtlMs).toBe(1800000);
  });
});

// ---------------------------------------------------------------------------
// Governance surfacing — read-only delegate queue depth + runner mode
// ---------------------------------------------------------------------------
describe("delegate governance surfacing (CTL-1331)", () => {
  let envCatalystDir;
  let prevCatalystDir;
  beforeEach(() => {
    prevCatalystDir = process.env.CATALYST_DIR;
    envCatalystDir = mkdtempSync(join(tmpdir(), "ctl1331-gov-"));
    process.env.CATALYST_DIR = envCatalystDir; // getExecutionCoreDir() resolves under this
  });
  afterEach(() => {
    if (prevCatalystDir === undefined) delete process.env.CATALYST_DIR;
    else process.env.CATALYST_DIR = prevCatalystDir;
    rmSync(envCatalystDir, { recursive: true, force: true });
  });

  function writeIntent(ticket, status) {
    const dir = join(envCatalystDir, "execution-core", ".delegate-queue");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${ticket}.json`), JSON.stringify({ status, kind: "board-health" }));
  }

  test("readDelegateQueueDepth returns 0 when the queue dir is absent (inert Phase A)", () => {
    expect(readDelegateQueueDepth()).toBe(0);
  });

  test("counts only queued|claimed intents, never launched/failed/superseded", () => {
    writeIntent("CTL-Q1", "queued");
    writeIntent("CTL-Q2", "queued");
    writeIntent("CTL-C1", "claimed");
    writeIntent("CTL-L1", "launched");
    writeIntent("CTL-F1", "failed");
    writeIntent("CTL-S1", "superseded");
    expect(readDelegateQueueDepth()).toBe(3);
  });

  test("ignores claim sidecars / tmp artifacts and unparseable files", () => {
    const dir = join(envCatalystDir, "execution-core", ".delegate-queue");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "CTL-Q1.json"), JSON.stringify({ status: "queued" }));
    writeFileSync(join(dir, "CTL-Q1.json.claimed-123-456"), JSON.stringify({ status: "queued" }));
    writeFileSync(join(dir, "CTL-Q2.json.tmp-1-2"), JSON.stringify({ status: "queued" }));
    writeFileSync(join(dir, "CTL-BAD.json"), "{ not valid json");
    expect(readDelegateQueueDepth()).toBe(1);
  });

  test("readGovernanceConfig surfaces delegateRunner { mode, queueDepth } (read-only)", () => {
    writeIntent("CTL-Q1", "queued");
    const gov = readGovernanceConfig({
      CATALYST_DIR: envCatalystDir,
      CATALYST_LAYER2_CONFIG_FILE: "/nonexistent/ctl1331/config.json",
      CATALYST_BOARD_HEALTH: "enforce",
    });
    expect(gov.delegateRunner).toBeDefined();
    expect(gov.delegateRunner.mode).toBe("on"); // coupled to board-health=enforce
    expect(gov.delegateRunner.queueDepth).toBe(1);
  });

  test("governance delegateRunner mode is 'off' when board-health is shadow (default)", () => {
    const gov = readGovernanceConfig({
      CATALYST_DIR: envCatalystDir,
      CATALYST_LAYER2_CONFIG_FILE: "/nonexistent/ctl1331/config.json",
      CATALYST_BOARD_HEALTH: "shadow",
    });
    expect(gov.delegateRunner.mode).toBe("off");
    expect(gov.delegateRunner.queueDepth).toBe(0);
  });
});
