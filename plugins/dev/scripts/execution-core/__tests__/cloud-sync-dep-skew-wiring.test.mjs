// cloud-sync-dep-skew-wiring.test.mjs — CTL-1659. A SOURCE-SCAN parity test over
// cloud-sync.mjs, in the shape broker/namespace-parity.test.mjs uses for recovery.mjs.
//
// Why a source scan rather than a behavioural test. cloud-sync.mjs is script-shaped: it
// imports the real @catalyst-cloud SDK at module scope, opens a socket, and ends in
// `await new Promise(() => {})`. It cannot be imported by a test, which is exactly why its
// pure helpers were factored into cloud-sync-telemetry.mjs / cloud-sync-deps.mjs in the
// first place. But a fully-tested helper that no caller invokes is THE failure mode this
// ticket exists to remove — `restart_needed` was a correct signal with no consumer, and
// ADR-018's Phase 1 shipped a whole shadow-write mechanism whose only reader was a manual
// CLI. So the wiring itself gets an assertion, and the assertion's own instrument is
// positive-controlled below: a grep that cannot find a known-present anchor is not
// evidence about the anchors it cannot find.
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "cloud-sync.mjs"), "utf8");

describe("cloud-sync.mjs dep-skew wiring", () => {
  test("POSITIVE CONTROL — the instrument finds anchors known to be present", () => {
    // If these ever return 0 the scan is broken and every assertion below is vacuous.
    expect(SRC).toContain("classifyStall"); // the CTL-1508 sibling predicate
    expect(SRC).toContain("exitAfterClose"); // the CTL-1508 bounded exit
    expect(SRC.length).toBeGreaterThan(1000);
  });

  test("the boot record is CAPTURED and WRITTEN — otherwise doctor has nothing to grade", () => {
    expect(SRC).toContain("captureLoadedDeps");
    expect(SRC).toContain("writeDepsBreadcrumb");
    // Resolution goes through the real module resolver, so the record describes what was
    // ACTUALLY loaded rather than what the lockfile claims (the CTL-1646 trap).
    expect(SRC).toMatch(/resolveModule:\s*\(specifier\)\s*=>\s*depsRequire\.resolve\(specifier\)/);
  });

  test("the predicate is EVALUATED on the heartbeat tick, against a re-read lockfile digest", () => {
    expect(SRC).toContain("classifyDepSkew");
    expect(SRC).toMatch(/sha256File\(DEP_SKEW_LOCK_PATH\)/);
  });

  test("the skew fields ride the EXISTING freshness heartbeat line (the alertable surface)", () => {
    // Not a separate opt-in line: shadow-mode detection that nobody can alert on is the
    // status quo with better logging.
    expect(SRC).toMatch(/freshnessFields\([\s\S]{0,400}?depSkewFields\(/);
  });

  test("the restart uses the EXISTING self-heal exit — breadcrumb + exit code 1, never 0", () => {
    // exit 0 is the plist's "clean no-op, launchd leaves it DOWN" contract
    // (KeepAlive={SuccessfulExit:false}); a literal clean exit would permanently stop the
    // replica writer. The ticket's own Option-1 wording is wrong on exactly this point.
    expect(SRC).toContain("reason: DEP_SKEW_REASON");
    const restartBlock = SRC.slice(SRC.indexOf("if (depSkew.restart)"));
    expect(restartBlock).toMatch(/exitAfterClose\(\{\s*closePromise: replica\.close\(\),\s*exitCode: 1/);
    expect(restartBlock).not.toMatch(/exitCode:\s*0/);
  });

  test("no FOURTH restart mechanism is introduced — the daemon never shells out to restart itself", () => {
    // The subtraction win of this design is that every actuator already exists: launchd
    // KeepAlive restarts, health-responder.sh escalates, the heartbeat tick is the safe
    // exit point. A self-restarting daemon that shells out would be a new mechanism.
    //
    // Matched STRUCTURALLY (an import, a call, a command line) rather than by the bare
    // words "kickstart"/"launchctl", which appear legitimately in this file's prose — the
    // unstructured-match-over-structured-data trap that has produced false results here.
    expect(SRC).not.toMatch(/from\s+["']node:child_process["']/);
    expect(SRC).not.toMatch(/\b(?:spawnSync|spawn|execSync|execFileSync|execFile)\s*\(/);
    expect(SRC).not.toMatch(/launchctl\s+(?:kickstart|bootout|bootstrap)/);
    // Positive control on those negatives: the same instruments DO match this file's real
    // import and call shapes, so a zero above is a measurement rather than a broken regex.
    expect(SRC).toMatch(/from\s+["']node:fs["']/);
    expect(SRC).toMatch(/\bexitAfterClose\s*\(/);
  });

  test("the durable restart budget is spent BEFORE the exit (the loop terminator is wired)", () => {
    const restartBlock = SRC.slice(SRC.indexOf("if (depSkew.restart)"));
    expect(restartBlock.indexOf("recordRestartAttempt")).toBeGreaterThan(-1);
    expect(restartBlock.indexOf("recordRestartAttempt")).toBeLessThan(restartBlock.indexOf("exitAfterClose"));
  });

  test("mode defaults to SHADOW and is operator-selectable", () => {
    expect(SRC).toContain("resolveDepSkewMode(process.env.CATALYST_CLOUD_SYNC_DEP_SKEW)");
    // off is fully dormant: no capture, no breadcrumb, nothing written.
    expect(SRC).toMatch(/if \(DEP_SKEW_MODE !== "off"\)/);
  });
});

describe("stack-reload is deliberately NOT the trigger", () => {
  test("cloud-sync stays out of decideStackReload's component list, by design", () => {
    // Adding it there is the symmetric CTL-1506 move and was considered and rejected: it
    // fires only on hosts where the BROKER advances the checkout (a host whose
    // catalyst-updater pulls without a broker never gets the push), and it would need new
    // kickstart plumbing plus a real per-component confirmation probe — cloud-sync has no
    // pid file readPidFor knows, and CTL-1506's own P1 lesson is that a best-effort
    // `return true` confirmation is how a stale daemon hides. The in-daemon predicate
    // covers every host cloud-sync runs on, by construction, and its confirmation is free:
    // the next boot overwrites the record. One trigger, not two.
    const reload = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "broker", "stack-reload.mjs"), "utf8");
    expect(reload).not.toContain("cloud-sync");
    // POSITIVE CONTROL for that negative — the same instrument on the same file finds the
    // components that ARE listed. Without this, a typo'd path would "prove" the absence.
    expect(reload).toContain("execution-core");
    expect(reload).toContain("otel-forward");
  });
});
