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
import { dirname as pathDirname, join as pathJoin } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("./recovery-emit.mjs", import.meta.url));

let catalystDir; // CATALYST_DIR → events land at <catalystDir>/events/YYYY-MM.jsonl
let orchDir; // --orch-dir → ledger at <orchDir>/.recovery-intents/<ticket>.json
let captureFile; // the stub comment helper appends "<ticket>\n---\n<body>" here
let labelStateFile; // CTL-1568: labels the stub linearis has "applied", one set per line
let linearisCallsFile; // CTL-1568: every stub linearis invocation, one per line

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

// CTL-1568 (Codex #2861 P0): the recovery-pass skill invokes this CLI with `node`
// (its shebang is `#!/usr/bin/env node`), NOT with Bun. Spawning it through Bun's
// `process.execPath` is what hid the P0: a static `linear-write.mjs` import reached
// `bun:sqlite`, which Bun resolves happily and Node rejects with
// ERR_UNSUPPORTED_ESM_URL_SCHEME at module-load time — killing every subcommand in
// production while the suite stayed green. Run against the REAL node entrypoint so
// the interpreter under test is the one the skill actually uses. Falls back to
// process.execPath only if node is genuinely absent, so the suite still runs on a
// node-less machine rather than silently failing.
const NODE_BIN = (() => {
  const probe = spawnSync("node", ["--version"], { encoding: "utf8" });
  return probe.status === 0 ? "node" : process.execPath;
})();

function runCli(args, envOverride = {}) {
  return spawnSync(NODE_BIN, [CLI, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      CATALYST_DIR: catalystDir,
      CATALYST_COMMENT_POST_HELPER: pathJoin(catalystDir, "stub-comment-post.sh"),
      CATALYST_RECOVERY_PASS: "enforce",
      // CTL-1568: PATH is pinned to a stub `linearis` FIRST. The shim now applies the
      // needs-human label, which shells `linearis issues update` + a read-back. With
      // the real binary on PATH these tests wrote to LIVE Linear — verified: a run of
      // this suite applied needs-human to the real CTL-520 and CTL-521. Stubbing the
      // comment helper alone was never enough; the transport is what must be sealed.
      // Runtime is the tell (seconds ⇒ real network, milliseconds ⇒ stubbed).
      PATH: `${pathJoin(catalystDir, "bin")}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
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

  // CTL-1568: hermetic `linearis` stub — see the PATH note in runCli. Records every
  // invocation, then serves the two verbs the label path needs:
  //   issues update … --labels X --label-mode add   → exit 0 (the write)
  //   issues read <id>                              → the read-back applyLabel
  //     verifies against; echoes back whatever labels have been "added" so far, so
  //     applied:true is reached only when the write genuinely preceded it.
  // Default-exit 1 on any unrecognized verb, so a new shell-out surfaces loudly here
  // instead of silently reaching the network.
  mkdirSync(pathJoin(catalystDir, "bin"), { recursive: true });
  labelStateFile = pathJoin(catalystDir, "linearis-labels.txt");
  linearisCallsFile = pathJoin(catalystDir, "linearis-calls.txt");
  const linearisStub = pathJoin(catalystDir, "bin", "linearis");
  writeFileSync(
    linearisStub,
    `#!/bin/bash
printf '%s\\n' "$*" >> "${linearisCallsFile}"
if [[ "$1" == "issues" && "$2" == "update" ]]; then
  for i in "$@"; do prev_is_labels=\${is_labels:-}; done
  # capture the value following --labels
  while [[ $# -gt 0 ]]; do
    if [[ "$1" == "--labels" ]]; then printf '%s\\n' "$2" >> "${labelStateFile}"; fi
    shift
  done
  exit 0
fi
if [[ "$1" == "issues" && "$2" == "read" ]]; then
  nodes=""
  if [[ -f "${labelStateFile}" ]]; then
    while IFS= read -r line; do
      IFS=',' read -ra parts <<< "$line"
      for p in "\${parts[@]}"; do
        [[ -z "$p" ]] && continue
        [[ -n "$nodes" ]] && nodes="$nodes,"
        nodes="$nodes{\\"id\\":\\"id-$p\\",\\"name\\":\\"$p\\"}"
      done
    done < "${labelStateFile}"
  fi
  printf '{"identifier":"%s","labels":{"nodes":[%s]}}\\n' "$3" "$nodes"
  exit 0
fi
echo "stub linearis: unexpected invocation: $*" >&2
exit 1
`,
  );
  chmodSync(linearisStub, 0o755);
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
    // CTL-1552: status normalized to the terminal "stalled" + stalledReason (was
    // "needs-human"); needs-human semantics ride on stalledReason/needsHumanSince/
    // explanation, not the raw status.
    expect(sig.status).toBe("stalled");
    expect(sig.stalledReason).toBe("needs_human");
    expect(typeof sig.needsHumanSince).toBe("string");
    expect(sig.needsHumanSince).not.toBe("");
    expect(sig.explanation).toBeDefined();
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

// ─── CTL-1568: the escalation comment and the ESCALATION RECORD are one act ───
// ⛔ CTL-2159 rewrote what the second half of that pair IS. It was the Linear
// `needs-human` label, so a rate-limited label write withheld the comment, left
// the ledger unlatched, and burned a retry budget until it gave up loudly. The
// pairing survives — the comment still posts only when the escalation is
// PUBLISHED — but publishing is now a local, classified act, so a shared-quota
// 429 can no longer decide whether a human hears about a stuck ticket.
// Fake ticket ids throughout: the PATH stub seals the transport, but these ids must
// never name a real ticket even if that seal is one day removed.
describe("recovery-emit escalated — needs-human label (CTL-1568)", () => {
  const escalation = JSON.stringify({
    escalation_type: "decision",
    problem: "the loop cannot close",
    call_to_action: "decide whether to keep retrying",
  });
  const linearisCalls = () =>
    existsSync(linearisCallsFile) ? readFileSync(linearisCallsFile, "utf8") : "";

  test("escalated PUBLISHES the escalation and posts the comment — with NO label write", () => {
    const res = runCli([
      "escalated", "--ticket", "TST-900", "--orch-dir", orchDir,
      "--phase", "recovery-pass", "--escalation", escalation,
    ]);
    expect(res.status).toBe(0);
    // ⛔ CTL-2159: the label write is gone from the transport entirely.
    expect(linearisCalls()).not.toContain("--labels needs-human");
    // POSITIVE CONTROL for the instrument. The label write was the ONLY thing on
    // this path that touched linearis, so an empty call log is now the expected
    // state and "not called" is indistinguishable from "recorder broken" unless
    // the recorder is proven separately. Drive the stub directly and watch the
    // same probe go non-empty.
    spawnSync(pathJoin(catalystDir, "bin", "linearis"), ["issues", "update", "TST-PC", "--labels", "needs-human"], {
      encoding: "utf8",
      env: { ...process.env, CATALYST_DIR: catalystDir, LINEARIS_CALLS_FILE: linearisCallsFile },
    });
    expect(linearisCalls()).toContain("needs-human");
    // …and the comment is posted, because the escalation was published
    expect(readFileSync(captureFile, "utf8")).toContain("TST-900");
    expect(res.stdout).toContain("needs-human=applied");
  });

  // ⛔ CTL-2159 — THE INVERSION. This pair used to pin "a FAILED label write
  // withholds the comment" and "a label that FAILS repeatedly eventually latches,
  // loudly". Both premises are gone with the label: a broken Linear `issues
  // update` transport can no longer withhold a human-facing escalation, so there
  // is no split to alarm on and no retry budget to exhaust. That is the point —
  // the CTL-638 storm those guards contained was caused by the label write they
  // were guarding.
  test("CTL-2159 — a broken Linear transport no longer withholds the comment or splits", () => {
    // Break the label-shaped write exactly as before: the stub exits non-zero.
    writeFileSync(
      pathJoin(catalystDir, "bin", "linearis"),
      `#!/bin/bash\nif [[ "$1" == "issues" && "$2" == "update" ]]; then echo "rate limited" >&2; exit 1; fi\nprintf '{"identifier":"%s","labels":{"nodes":[]}}\\n' "$3"\nexit 0\n`,
    );
    chmodSync(pathJoin(catalystDir, "bin", "linearis"), 0o755);
    const res = runCli([
      "escalated", "--ticket", "TST-901", "--orch-dir", orchDir,
      "--phase", "recovery-pass", "--escalation", escalation,
    ]);
    expect(res.status).toBe(0);
    // The comment lands (was: withheld) and the ledger latches on the FIRST pass
    // (was: left unlatched to retry for up to a whole budget).
    expect(existsSync(captureFile)).toBe(true);
    expect(readLedger("TST-901").escalated).toBe(true);
    // No split: there are no longer two halves that can disagree.
    expect(readEvents().some((e) => e.attributes?.["event.name"] === "recovery.escalation.split")).toBe(false);
    // POSITIVE CONTROL: the durable escalation event DID land, so the zero above
    // is not an empty event log.
    expect(readEvents().some((e) => e.attributes?.["event.name"] === "recovery.escalated")).toBe(true);
  });

  test("shadow mode writes NEITHER label nor comment", () => {
    const res = runCli(
      ["escalated", "--ticket", "TST-902", "--orch-dir", orchDir, "--escalation", escalation],
      { CATALYST_RECOVERY_PASS: "shadow" },
    );
    expect(res.status).toBe(0);
    expect(linearisCalls()).not.toContain("--labels needs-human");
    expect(existsSync(captureFile)).toBe(false);
  });
});

// ─── CTL-1568 (Codex #2861 P0): the Node entrypoint must stay Bun-free ───────
// recovery-emit.mjs ships `#!/usr/bin/env node` and the recovery-pass skill invokes
// it with node. Its import graph reaches linear-write.mjs → linear-query.mjs →
// gateway-read.mjs, which used to statically `import { Database } from "bun:sqlite"`.
// Node rejects that specifier at module-load time (ERR_UNSUPPORTED_ESM_URL_SCHEME),
// so EVERY subcommand died before dispatch. These assert the graph stays loadable
// under real node — the runtime that actually runs it in production.

describe("CTL-1568 P0 — the node entrypoint loads without Bun-only specifiers", () => {
  const nodeCan = (expr) =>
    spawnSync("node", ["-e", expr], { encoding: "utf8", cwd: pathDirname(CLI) });

  test("linear-write.mjs (the labelling dependency) imports under node", () => {
    const r = nodeCan(
      `import("./linear-write.mjs").then(m=>{if(typeof m.applyLabel!=="function")process.exit(3);process.exit(0)}).catch(e=>{console.error(e.code||e.message);process.exit(1)})`,
    );
    expect(r.stderr ?? "").not.toContain("ERR_UNSUPPORTED_ESM_URL_SCHEME");
    expect(r.status).toBe(0);
  });

  test("gateway-read.mjs's pure helpers import under node (no db construction)", () => {
    const r = nodeCan(
      `import("./gateway-read.mjs").then(m=>{if(m.descriptorAgeMs({updatedAt:new Date().toISOString()})>60000)process.exit(3);process.exit(0)}).catch(e=>{console.error(e.code||e.message);process.exit(1)})`,
    );
    expect(r.stderr ?? "").not.toContain("ERR_UNSUPPORTED_ESM_URL_SCHEME");
    expect(r.status).toBe(0);
  });

  test("every subcommand dispatches under node instead of dying at load", () => {
    for (const sub of ["fixed", "leave-alone", "escalated"]) {
      const r = runCli([sub, "--ticket", "TST-P0", "--reason", "probe"], {
        CATALYST_RECOVERY_PASS: "shadow",
      });
      expect(r.stderr ?? "").not.toContain("ERR_UNSUPPORTED_ESM_URL_SCHEME");
    }
  });
});
