// recovery-emit.test.mjs — CTL-1439 (P0a): the recovery-pass CLI shim persists
// the session's ACTUAL verdict (fixed / leave-alone / escalated) to all three
// surfaces — the unified event log, the recovery-intent ledger, and (for
// leave-alone/escalated) a ticket-visible Linear comment — instead of the
// pre-dispatch placeholder being the only durable trace.
//
// Run: cd plugins/dev/scripts/execution-core && bun test recovery-emit.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  chmodSync,
} from "node:fs";
import { join as pathJoin } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("./recovery-emit.mjs", import.meta.url));

let catalystDir; // CATALYST_DIR → events land at <catalystDir>/events/YYYY-MM.jsonl
let orchDir; // --orch-dir → ledger at <orchDir>/.recovery-intents/<ticket>.json
let captureFile; // the stub comment helper appends "<ticket>\n---\n<body>" here

function eventLogPath() {
  const now = new Date();
  const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  return pathJoin(catalystDir, "events", `${ym}.jsonl`);
}

function readEvents() {
  if (!existsSync(eventLogPath())) return [];
  return readFileSync(eventLogPath(), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function readLedger(ticket) {
  return JSON.parse(
    readFileSync(pathJoin(orchDir, ".recovery-intents", `${ticket}.json`), "utf8"),
  );
}

function seedLedger(ticket, entry) {
  const dir = pathJoin(orchDir, ".recovery-intents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(pathJoin(dir, `${ticket}.json`), JSON.stringify(entry));
}

function runCli(args, envOverride = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      CATALYST_DIR: catalystDir,
      CATALYST_COMMENT_POST_HELPER: pathJoin(catalystDir, "stub-comment-post.sh"),
      CATALYST_RECOVERY_PASS: "enforce",
      ...envOverride,
    },
  });
}

beforeEach(() => {
  catalystDir = mkdtempSync(pathJoin(tmpdir(), "rec-emit-"));
  orchDir = pathJoin(catalystDir, "execution-core");
  mkdirSync(orchDir, { recursive: true });
  captureFile = pathJoin(catalystDir, "comment-capture.txt");
  const stub = pathJoin(catalystDir, "stub-comment-post.sh");
  writeFileSync(stub, `#!/bin/bash\nprintf '%s\\n---\\n%s\\n' "$1" "$2" >> "${captureFile}"\n`);
  chmodSync(stub, 0o755);
});

afterEach(() => {
  try {
    rmSync(catalystDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe("recovery-emit leave-alone (CTL-1439 P0a)", () => {
  test("happy path: recovery.verdict event + ledger leave-alone (attempt refunded) + Linear comment", () => {
    seedLedger("CTL-500", { ticket: "CTL-500", ts: 1, lastTs: 1, decision: "dispatched", fix_class: "board-health", attempts: 2, escalated: false });
    const res = runCli([
      "leave-alone",
      "--ticket", "CTL-500",
      "--orch-dir", orchDir,
      "--reason", "needs-human label is stale; the human is actively driving this worktree",
    ]);
    expect(res.status).toBe(0);

    // (c) ticket-tagged verdict event in the unified log
    const events = readEvents();
    const verdict = events.find((e) => e.attributes?.["event.name"] === "recovery.verdict");
    expect(verdict).toBeDefined();
    expect(verdict.attributes["event.label"]).toBe("CTL-500");
    expect(verdict.severityText).toBe("INFO");
    expect(verdict.body.payload.details.verdict).toBe("leave-alone");
    expect(verdict.body.payload.reason).toContain("stale");

    // (b) the ACTUAL verdict in the ledger, (d) attempt refunded
    const ledger = readLedger("CTL-500");
    expect(ledger.decision).toBe("leave-alone");
    expect(ledger.verdict).toBe("leave-alone");
    expect(ledger.attempts).toBe(1);

    // (a) ticket-visible comment through the app-actor helper
    const captured = readFileSync(captureFile, "utf8");
    expect(captured).toContain("CTL-500");
    expect(captured).toContain("recovery-pass");
    expect(captured).toContain("stale");
  });

  test("missing --reason → exit 2, nothing written", () => {
    const res = runCli(["leave-alone", "--ticket", "CTL-501", "--orch-dir", orchDir]);
    expect(res.status).toBe(2);
    expect(readEvents()).toHaveLength(0);
    expect(existsSync(pathJoin(orchDir, ".recovery-intents", "CTL-501.json"))).toBe(false);
  });

  test("missing --ticket → exit 2", () => {
    const res = runCli(["leave-alone", "--reason", "x", "--orch-dir", orchDir]);
    expect(res.status).toBe(2);
  });

  test("--no-comment suppresses the comment but keeps event + ledger", () => {
    const res = runCli([
      "leave-alone", "--ticket", "CTL-502", "--orch-dir", orchDir,
      "--reason", "flag is a false positive", "--no-comment",
    ]);
    expect(res.status).toBe(0);
    expect(existsSync(captureFile)).toBe(false);
    expect(readEvents().some((e) => e.attributes?.["event.name"] === "recovery.verdict")).toBe(true);
    expect(readLedger("CTL-502").decision).toBe("leave-alone");
  });

  test("shadow mode never posts a comment (event + ledger still land)", () => {
    const res = runCli(
      ["leave-alone", "--ticket", "CTL-503", "--orch-dir", orchDir, "--reason", "healthy"],
      { CATALYST_RECOVERY_PASS: "shadow" },
    );
    expect(res.status).toBe(0);
    expect(existsSync(captureFile)).toBe(false);
    expect(readLedger("CTL-503").decision).toBe("leave-alone");
  });

  test("a failing comment helper never fails the emit (exit 0, verdict persisted)", () => {
    const badStub = pathJoin(catalystDir, "bad-stub.sh");
    writeFileSync(badStub, "#!/bin/bash\nexit 1\n");
    chmodSync(badStub, 0o755);
    const res = runCli(
      ["leave-alone", "--ticket", "CTL-504", "--orch-dir", orchDir, "--reason", "healthy"],
      { CATALYST_COMMENT_POST_HELPER: badStub },
    );
    expect(res.status).toBe(0);
    expect(readLedger("CTL-504").decision).toBe("leave-alone");
  });
});

describe("recovery-emit fixed — ledger verdict write (CTL-1439 P0a)", () => {
  test("fixed records decision:fixed with attempts PINNED (dispatch already counted)", () => {
    seedLedger("CTL-510", { ticket: "CTL-510", ts: 1, lastTs: 1, decision: "dispatched", fix_class: "board-health", attempts: 1, escalated: false });
    const res = runCli([
      "fixed", "--ticket", "CTL-510", "--orch-dir", orchDir,
      "--reason", "Resolved the rebase conflict; merged #2163.",
    ]);
    expect(res.status).toBe(0);
    const events = readEvents();
    expect(events.some((e) => e.attributes?.["event.name"] === "recovery.fixed" && e.attributes?.["event.label"] === "CTL-510")).toBe(true);
    const ledger = readLedger("CTL-510");
    expect(ledger.decision).toBe("fixed");
    expect(ledger.verdict).toBe("fixed");
    expect(ledger.attempts).toBe(1); // pinned, not double-counted
  });

  test("fixed without any orch dir still emits the event (ledger skipped, fail-open)", () => {
    const res = runCli(["fixed", "--ticket", "CTL-511", "--reason", "merged"], {
      CATALYST_ORCHESTRATOR_DIR: "",
    });
    expect(res.status).toBe(0);
    expect(readEvents().some((e) => e.attributes?.["event.name"] === "recovery.fixed")).toBe(true);
  });
});

describe("recovery-emit escalated — comment surfacing (CTL-1439 P0a)", () => {
  const escalation = JSON.stringify({
    escalation_type: "decision",
    problem: "two valid dispatch shapes collide",
    call_to_action: "pick per-host pinning or quota-aware",
  });

  test("escalated posts the ticket comment AND keeps event + signal + latch", () => {
    const res = runCli([
      "escalated", "--ticket", "CTL-520", "--orch-dir", orchDir,
      "--phase", "recovery-pass", "--escalation", escalation,
    ]);
    expect(res.status).toBe(0);
    // existing three surfaces intact
    expect(readEvents().some((e) => e.attributes?.["event.name"] === "recovery.escalated")).toBe(true);
    const sig = JSON.parse(readFileSync(pathJoin(orchDir, "workers", "CTL-520", "phase-recovery-pass.json"), "utf8"));
    expect(sig.status).toBe("needs-human");
    expect(readLedger("CTL-520").escalated).toBe(true);
    expect(readLedger("CTL-520").verdict).toBe("escalate");
    // NEW: the ticket-visible escalation comment is posted by the shim itself
    const captured = readFileSync(captureFile, "utf8");
    expect(captured).toContain("CTL-520");
    expect(captured).toContain("pick per-host pinning or quota-aware");
  });

  test("escalated --no-comment suppresses only the comment", () => {
    const res = runCli([
      "escalated", "--ticket", "CTL-521", "--orch-dir", orchDir,
      "--escalation", escalation, "--no-comment",
    ]);
    expect(res.status).toBe(0);
    expect(existsSync(captureFile)).toBe(false);
    expect(readLedger("CTL-521").escalated).toBe(true);
  });
});
