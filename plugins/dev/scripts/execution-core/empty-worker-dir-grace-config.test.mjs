// empty-worker-dir-grace-config.test.mjs — CAT-24. The empty-worker-dir grace
// reader: the window below which a BARE workers/<TICKET>/ dir is presumed to be
// phase-agent-dispatch's mkdir→first-signal window rather than reclaimable
// residue. Three-layer precedence (env > Layer-1
// catalyst.orchestration.orphanReaper.workerGc.emptyDirGraceSeconds > frozen
// default), mirroring readFleetHealthConfig / readDaemonWatchdogConfig.
//
// Run: cd plugins/dev/scripts/execution-core && bun test empty-worker-dir-grace-config.test.mjs

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readEmptyWorkerDirGraceMs,
  readEmptyWorkerDirGraceMsLayer1,
  EMPTY_WORKER_DIR_GRACE_DEFAULT_MS,
} from "./config.mjs";

let dir;
let saved;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cat24-grace-cfg-"));
  saved = process.env.CATALYST_EMPTY_WORKER_DIR_GRACE_MS;
  delete process.env.CATALYST_EMPTY_WORKER_DIR_GRACE_MS;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (saved === undefined) delete process.env.CATALYST_EMPTY_WORKER_DIR_GRACE_MS;
  else process.env.CATALYST_EMPTY_WORKER_DIR_GRACE_MS = saved;
});

function layer1(catalyst) {
  const p = join(dir, "config.json");
  writeFileSync(p, JSON.stringify(catalyst));
  return p;
}

const withGrace = (seconds) => ({
  catalyst: { orchestration: { orphanReaper: { workerGc: { emptyDirGraceSeconds: seconds } } } },
});

describe("readEmptyWorkerDirGraceMs (CAT-24)", () => {
  test("defaults to 10 minutes with no env and no config", () => {
    expect(readEmptyWorkerDirGraceMs({ env: {}, configPath: null })).toBe(
      EMPTY_WORKER_DIR_GRACE_DEFAULT_MS
    );
    expect(EMPTY_WORKER_DIR_GRACE_DEFAULT_MS).toBe(600_000);
  });

  test("reads Layer-1 orphanReaper.workerGc.emptyDirGraceSeconds (seconds → ms)", () => {
    expect(readEmptyWorkerDirGraceMs({ env: {}, configPath: layer1(withGrace(90)) })).toBe(90_000);
  });

  test("env wins over Layer-1", () => {
    expect(
      readEmptyWorkerDirGraceMs({
        env: { CATALYST_EMPTY_WORKER_DIR_GRACE_MS: "1234" },
        configPath: layer1(withGrace(90)),
      })
    ).toBe(1234);
  });

  test("a non-numeric or non-positive value at either layer falls through", () => {
    for (const bad of ["", "abc", "0", "-5"]) {
      expect(
        readEmptyWorkerDirGraceMs({
          env: { CATALYST_EMPTY_WORKER_DIR_GRACE_MS: bad },
          configPath: null,
        })
      ).toBe(EMPTY_WORKER_DIR_GRACE_DEFAULT_MS);
    }
    for (const bad of ["abc", 0, -5, null]) {
      expect(readEmptyWorkerDirGraceMs({ env: {}, configPath: layer1(withGrace(bad)) })).toBe(
        EMPTY_WORKER_DIR_GRACE_DEFAULT_MS
      );
    }
  });

  test("a missing / unparseable Layer-1 file degrades to the default, never throws", () => {
    const missing = join(dir, "nope.json");
    expect(readEmptyWorkerDirGraceMsLayer1(missing)).toBeUndefined();
    expect(readEmptyWorkerDirGraceMs({ env: {}, configPath: missing })).toBe(
      EMPTY_WORKER_DIR_GRACE_DEFAULT_MS
    );
    const junk = join(dir, "junk.json");
    writeFileSync(junk, "{not json");
    expect(readEmptyWorkerDirGraceMs({ env: {}, configPath: junk })).toBe(
      EMPTY_WORKER_DIR_GRACE_DEFAULT_MS
    );
  });

  test("an absent key in an otherwise valid config degrades to the default", () => {
    const p = layer1({ catalyst: { orchestration: {} } });
    expect(readEmptyWorkerDirGraceMsLayer1(p)).toBeUndefined();
    expect(readEmptyWorkerDirGraceMs({ env: {}, configPath: p })).toBe(
      EMPTY_WORKER_DIR_GRACE_DEFAULT_MS
    );
  });
});
