// pid-file-identity.test.mjs — CTL-2028.
//
// Two brokers on mini-2 for 85 minutes, both alive, both heartbeating, while
// every status surface reported one — because the newer process had clobbered
// the pid file. And when the orphan finally exited, its unconditional
// `unlinkSync` deleted the SURVIVOR's pid file, leaving a healthy broker that
// status reported as DOWN. Both halves are covered here.
//
// Run: cd plugins/dev/scripts/execution-core && bun test pid-file-identity.test.mjs

import { describe, test, expect } from "bun:test";
import {
  readPidFrom,
  processCommand,
  classifyPidFile,
  shouldRemovePidFile,
  duplicateDaemonAlarm,
} from "../lib/pid-file-identity.mjs";

const MARKER = "broker/index.mjs";
/** a readFn returning `text`, or throwing to simulate an absent file. */
const reads = (text) => (text === null ? () => { throw new Error("ENOENT"); } : () => text);
/** an execFn answering `cmd` for any pid, or throwing (ps could not answer). */
const execs = (cmd) => (cmd === null ? () => { throw new Error("no such process"); } : () => cmd);

describe("readPidFrom — anything unreadable is 'I cannot tell', never 'nobody'", () => {
  test("a plain pid parses", () => {
    expect(readPidFrom("/x", { readFn: reads("4242\n") })).toBe(4242);
  });
  test("absent, empty, non-numeric, zero and negative all yield null", () => {
    for (const raw of [null, "", "   ", "not-a-pid", "0", "-5", "\n"]) {
      expect(readPidFrom("/x", { readFn: reads(raw) })).toBeNull();
    }
  });
});

describe("classifyPidFile — the four answers must stay apart", () => {
  test("the file names THIS process → self", () => {
    const v = classifyPidFile("/x", MARKER, { readFn: reads("77\n"), execFn: execs("irrelevant"), selfPid: 77 });
    expect(v.kind).toBe("self");
  });

  test("a DIFFERENT live process running the same daemon → live-peer", () => {
    const v = classifyPidFile("/x", MARKER, {
      readFn: reads("17643\n"),
      execFn: execs("bun /Users/ryan/catalyst/plugin-source/plugins/dev/scripts/broker/index.mjs --pid-file /Users/ryan/catalyst/broker.pid"),
      selfPid: 53448,
    });
    expect(v.kind).toBe("live-peer");
    expect(v.pid).toBe(17643);
  });

  test("⛔ a RECYCLED pid — alive, but a different program — is STALE, not a peer", () => {
    // Treating this as a live peer would make a legitimately stale pid file
    // permanently un-writable and wedge the daemon.
    const v = classifyPidFile("/x", MARKER, {
      readFn: reads("17643\n"),
      execFn: execs("/usr/bin/vim notes.txt"),
      selfPid: 53448,
    });
    expect(v.kind).toBe("stale");
    expect(v.reason).toBe("recycled-pid");
  });

  test("ps cannot answer → unknown, which is neither 'peer' nor 'nobody'", () => {
    const v = classifyPidFile("/x", MARKER, { readFn: reads("999\n"), execFn: execs(null), selfPid: 1 });
    expect(v.kind).toBe("unknown");
  });

  test("no file at all → absent", () => {
    expect(classifyPidFile("/x", MARKER, { readFn: reads(null), execFn: execs("x"), selfPid: 1 }).kind).toBe("absent");
  });

  test("all five kinds are distinct values — none may collapse into another", () => {
    const kinds = [
      classifyPidFile("/x", MARKER, { readFn: reads(null), execFn: execs("x"), selfPid: 1 }).kind,
      classifyPidFile("/x", MARKER, { readFn: reads("1\n"), execFn: execs("x"), selfPid: 1 }).kind,
      classifyPidFile("/x", MARKER, { readFn: reads("2\n"), execFn: execs(`bun ${MARKER}`), selfPid: 1 }).kind,
      classifyPidFile("/x", MARKER, { readFn: reads("2\n"), execFn: execs("/usr/bin/vim"), selfPid: 1 }).kind,
      classifyPidFile("/x", MARKER, { readFn: reads("2\n"), execFn: execs(null), selfPid: 1 }).kind,
    ];
    expect(new Set(kinds).size).toBe(5);
  });
});

describe("⛔ shouldRemovePidFile — the step-3 damage, and it was REPRODUCED", () => {
  // When the orphaned broker exited, its unconditional unlinkSync deleted the
  // LIVE one's pid file; status then reported the healthy survivor as DOWN and
  // the next supervisor pass would have started a third.
  test("only 'self' may unlink", () => {
    expect(shouldRemovePidFile({ kind: "self", pid: 1 })).toBe(true);
  });

  test("a live peer's file is LEFT ALONE — this is the reproduced incident", () => {
    expect(shouldRemovePidFile({ kind: "live-peer", pid: 17643 })).toBe(false);
  });

  test("⚠️ stale, unknown and absent are ALSO left alone — remove fails toward keeping", () => {
    // Opposite fail direction to writePidFile, deliberately: a wrongly-kept stale
    // file is cleared by the next start; a wrongly-deleted live one orphans a
    // daemon. "I could not tell" must therefore not unlink.
    for (const kind of ["stale", "unknown", "absent"]) {
      expect(shouldRemovePidFile({ kind, pid: 5 })).toBe(false);
    }
    expect(shouldRemovePidFile(undefined)).toBe(false);
    expect(shouldRemovePidFile(null)).toBe(false);
  });
});

describe("duplicateDaemonAlarm — names BOTH pids, because 'there are two' is not actionable", () => {
  test("a live peer produces an alarm naming both", () => {
    const msg = duplicateDaemonAlarm({ kind: "live-peer", pid: 17643 }, { name: "broker", selfPid: 53448 });
    expect(msg).toContain("17643");
    expect(msg).toContain("53448");
    expect(msg).toContain("duplicate broker");
  });

  test("every other kind produces NO alarm — the detector must sit silent when healthy", () => {
    for (const kind of ["self", "stale", "unknown", "absent"]) {
      expect(duplicateDaemonAlarm({ kind, pid: 1 }, { name: "broker" })).toBeNull();
    }
  });
});

describe("processCommand — reads the real ps, with a positive control", () => {
  test("POSITIVE CONTROL: this process's own command line is readable and names a runtime", () => {
    // Without this, the two 'returns null' assertions below could pass on a
    // helper that never manages to read anything at all.
    const cmd = processCommand(process.pid);
    expect(typeof cmd).toBe("string");
    expect(cmd.length).toBeGreaterThan(0);
  });

  test("a pid that cannot exist returns null rather than throwing", () => {
    expect(processCommand(2 ** 30)).toBeNull();
  });
});
