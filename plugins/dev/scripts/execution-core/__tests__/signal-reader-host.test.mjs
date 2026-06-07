// signal-reader-host.test.mjs — CTL-852 Phase 3: signal-reader surfaces host block.
// Run: cd plugins/dev/scripts/execution-core && bun test signal-reader-host

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWorkerSignals } from "../signal-reader.mjs";

let orchDir;

beforeEach(() => {
  orchDir = mkdtempSync(join(tmpdir(), "exec-core-sighost-"));
});

afterEach(() => {
  rmSync(orchDir, { recursive: true, force: true });
});

function writeNested(ticket, phase, body) {
  const dir = join(orchDir, "workers", ticket);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `phase-${phase}.json`),
    JSON.stringify({ ticket, phase, ...body }),
  );
}

describe("readWorkerSignals — host field (CTL-852)", () => {
  test("surfaces host block when present in signal file", () => {
    writeNested("CTL-852", "implement", {
      status: "running",
      bg_job_id: "abcd1234",
      host: { name: "test-host", id: "1234567890abcdef" },
    });
    const sigs = readWorkerSignals(orchDir);
    expect(sigs).toHaveLength(1);
    expect(sigs[0].host).toEqual({ name: "test-host", id: "1234567890abcdef" });
  });

  test("returns host: null when signal has no host field (back-compat)", () => {
    writeNested("CTL-100", "research", {
      status: "running",
      bg_job_id: "old-signal",
    });
    const sigs = readWorkerSignals(orchDir);
    expect(sigs).toHaveLength(1);
    expect(sigs[0].host).toBeNull();
  });

  test("does not throw on a signal missing host", () => {
    writeNested("CTL-200", "plan", {
      status: "done",
      bg_job_id: "no-host-bg",
    });
    expect(() => readWorkerSignals(orchDir)).not.toThrow();
  });

  test("host.name and host.id are accessible on the read model", () => {
    writeNested("CTL-852", "verify", {
      status: "running",
      bg_job_id: "eff01234",
      host: { name: "my-server", id: "abcdef0123456789" },
    });
    const sigs = readWorkerSignals(orchDir);
    expect(sigs[0].host?.name).toBe("my-server");
    expect(sigs[0].host?.id).toBe("abcdef0123456789");
  });
});
