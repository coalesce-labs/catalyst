// orphan-reaper-timer.test.mjs — Phase 9 of CTL-649. The periodic timer that
// emits `orphans.reap-requested` on a config-driven cadence, plus the config
// reader that threads .catalyst/config.json into it.

import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startOrphanReaperTimer, readOrphanReaperConfig } from "./orphan-reaper-timer.mjs";

// A controllable clock: records the single registered interval and fires its
// callback once per elapsed interval when advance() is called.
function fakeClock() {
  let reg = null;
  return {
    setInterval: (fn, ms) => {
      reg = { fn, ms };
      return { unref() {} };
    },
    clearInterval: () => {
      reg = null;
    },
    advance: (elapsedMs) => {
      if (!reg) return;
      const ticks = Math.floor(elapsedMs / reg.ms);
      for (let i = 0; i < ticks; i++) reg.fn();
    },
    registered: () => reg,
  };
}

describe("startOrphanReaperTimer", () => {
  it("emits orphans.reap-requested every interval", () => {
    const emitted = [];
    const clock = fakeClock();
    startOrphanReaperTimer({ intervalSeconds: 600, emit: (e) => emitted.push(e), clock });
    clock.advance(600_000);
    expect(emitted.length).toBe(1);
    clock.advance(600_000);
    expect(emitted.length).toBe(2);
    expect(emitted[0]).toBe("orphans.reap-requested");
  });

  it("honors a config-overridden interval", () => {
    const emitted = [];
    const clock = fakeClock();
    startOrphanReaperTimer({ intervalSeconds: 60, emit: (e) => emitted.push(e), clock });
    clock.advance(60_000);
    expect(emitted.length).toBe(1);
  });

  it("is a no-op when disabled", () => {
    const emitted = [];
    const clock = fakeClock();
    const handle = startOrphanReaperTimer({
      enabled: false,
      intervalSeconds: 60,
      emit: (e) => emitted.push(e),
      clock,
    });
    clock.advance(600_000);
    expect(emitted.length).toBe(0);
    expect(clock.registered()).toBeNull();
    expect(typeof handle.stop).toBe("function");
  });

  it("stop() clears the interval", () => {
    const emitted = [];
    const clock = fakeClock();
    const handle = startOrphanReaperTimer({
      intervalSeconds: 60,
      emit: (e) => emitted.push(e),
      clock,
    });
    handle.stop();
    clock.advance(600_000);
    expect(emitted.length).toBe(0);
  });
});

describe("readOrphanReaperConfig", () => {
  let dir;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  const writeConfig = (obj) => {
    dir = mkdtempSync(join(tmpdir(), "ctl649-cfg-"));
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify(obj));
    return path;
  };

  it("reads catalyst.orchestration.orphanReaper", () => {
    const path = writeConfig({
      catalyst: { orchestration: { orphanReaper: { enabled: false, intervalSeconds: 120 } } },
    });
    expect(readOrphanReaperConfig(path)).toEqual({ enabled: false, intervalSeconds: 120 });
  });

  it("returns an empty object when the key is absent", () => {
    const path = writeConfig({ catalyst: { orchestration: {} } });
    expect(readOrphanReaperConfig(path)).toEqual({});
  });

  it("returns an empty object for a missing file", () => {
    expect(readOrphanReaperConfig("/no/such/config.json")).toEqual({});
  });

  it("returns an empty object for malformed JSON", () => {
    dir = mkdtempSync(join(tmpdir(), "ctl649-cfg-"));
    const path = join(dir, "config.json");
    writeFileSync(path, "{ not json");
    expect(readOrphanReaperConfig(path)).toEqual({});
  });

  it("returns {} for a null/empty path", () => {
    expect(readOrphanReaperConfig(null)).toEqual({});
    expect(readOrphanReaperConfig("")).toEqual({});
  });
});
