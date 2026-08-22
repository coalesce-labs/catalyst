// daemon-signals.test.mjs — CTL-2147. Asserts the execution-core daemon wires its
// SIGHUP handler via wireRearmSighup(process, { armSecret, log }).
//
// WHY A SOURCE SCAN, NOT A LIVE BOOT: the process.on("SIGINT"/"SIGTERM"/"SIGHUP", ...)
// registrations live inside daemon.mjs's `main()`, which is guarded by
// `if (import.meta.main) main();` and is not exported — daemon.test.mjs already
// imports startDaemon/stopDaemon directly and never calls main() (booting the real
// daemon would start real timers, child processes, and fs.watch handles). This
// follows the same source-scan convention namespace-parity.test.mjs uses for
// recovery.mjs's dynamic phase-slot producers: read the real file, assert the wiring
// text is present, so a later refactor that silently drops the registration fails
// this test instead of only failing manually on the next `catalyst-execution-core
// rearm` call.
//
// This is deliberately a THIN scan: `wireRearmSighup` (claude-accounts-rearm.mjs) is
// the function that actually calls `proc.on("SIGHUP", ...)`, and its own live
// behavior — a listener is registered, firing SIGHUP invokes armSecret, it never
// registers on SIGINT/SIGTERM, a throwing armSecret doesn't propagate — is exercised
// against a real EventEmitter in claude-accounts-rearm.test.mjs's "wireRearmSighup"
// suite. This file's only job is to prove daemon.mjs actually CALLS that function,
// with the real `process`/`armSecret`/`log`, rather than some dead or divergent copy.
//
// Run: cd plugins/dev/scripts/execution-core && bun test daemon-signals.test.mjs

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DAEMON_SOURCE = readFileSync(
  join(fileURLToPath(import.meta.url), "../daemon.mjs"),
  "utf8",
);

describe("daemon.mjs SIGHUP wiring (CTL-2147)", () => {
  test("imports wireRearmSighup from claude-accounts-rearm.mjs", () => {
    expect(DAEMON_SOURCE).toMatch(
      /import\s*\{[^}]*wireRearmSighup[^}]*\}\s*from\s*"\.\/claude-accounts-rearm\.mjs"/,
    );
  });

  test("calls wireRearmSighup(process, { armSecret, log }) — not a dead/divergent inline handler", () => {
    expect(DAEMON_SOURCE).toMatch(
      /wireRearmSighup\(process,\s*\{[^}]*armSecret[^}]*log[^}]*\}\)/,
    );
  });

  test("SIGINT and SIGTERM still route to shutdown() (SIGHUP wiring didn't regress them)", () => {
    expect(DAEMON_SOURCE).toContain('process.on("SIGINT", () => shutdown("SIGINT"));');
    expect(DAEMON_SOURCE).toContain('process.on("SIGTERM", () => shutdown("SIGTERM"));');
  });

  test("no leftover inline SIGHUP process.on (superseded by wireRearmSighup)", () => {
    expect(DAEMON_SOURCE).not.toMatch(/process\.on\("SIGHUP",\s*makeRearmSignalHandler/);
  });
});
