// event-log-retention-wiring.test.mjs — CTL-2189, Codex #3953 P1.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE EXISTS, AND WHY IT IS SEPARATE FROM THE UNIT TESTS
// ─────────────────────────────────────────────────────────────────────────────
// The first version of this feature shipped a correct, thoroughly-tested
// `runRetention` that NOTHING CALLED. Every unit test passed. A repo-wide search
// found the export only in its own module and its own test file, so no
// production process ever enumerated or deleted a partition — and because
// `apply` also defaulted to false, there were TWO independent reasons for
// nothing to happen.
//
// A test that only proves "the function works when called directly" cannot
// distinguish that from a working feature. So this file asserts the OTHER half:
//
//   1. the daemon actually binds it onto a real execution path (source scan —
//      the same technique recovery-judgment-removed.test.mjs and
//      broker/namespace-parity.test.mjs use, and the only thing that can fail
//      loudly when the subject under test is a wiring absence);
//   2. the timer it is bound to actually invokes the seam on a tick;
//   3. the bound sweep actually UNLINKS — i.e. the production factory applies,
//      rather than dry-running forever.
//
//   cd plugins/dev/scripts/execution-core && bun test event-log-retention-wiring.test.mjs

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createEventLogRetentionSweep } from "./event-log-retention.mjs";
import { startOrphanReaperTimer } from "./orphan-reaper-timer.mjs";

const EXEC_CORE_DIR = dirname(fileURLToPath(import.meta.url));
const readSource = (rel) => readFileSync(join(EXEC_CORE_DIR, rel), "utf8");

describe("P1 — the daemon binds retention onto a real execution path", () => {
  const daemon = readSource("daemon.mjs");

  test("daemon.mjs imports the production factory", () => {
    expect(daemon).toMatch(
      /import\s*\{\s*createEventLogRetentionSweep\s*\}\s*from\s*"\.\/event-log-retention\.mjs"/
    );
  });

  test("daemon.mjs constructs the sweep", () => {
    expect(daemon).toMatch(/createEventLogRetentionSweep\(\{/);
  });

  test("daemon.mjs passes it to startOrphanReaperTimer — the actual scheduler", () => {
    // Narrowed to the startOrphanReaperTimer call itself: a mention anywhere in
    // the file would pass a naive substring check while still being unwired.
    const call = /_orphanTimer\s*=\s*startOrphanReaperTimer\(\{[\s\S]*?\}\);/.exec(daemon);
    expect(call).not.toBeNull();
    expect(call[0]).toMatch(/\beventLogRetention\b/);
  });

  test("PLANTED CONTROL: the same scan does NOT find a seam the daemon never passes", () => {
    // Proves the three assertions above are reading the real call site rather
    // than matching something that is true of any text. If this ever passes for
    // a fabricated name, the assertions above prove nothing.
    const call = /_orphanTimer\s*=\s*startOrphanReaperTimer\(\{[\s\S]*?\}\);/.exec(daemon);
    expect(call[0]).not.toMatch(/\beventLogRetentionThatDoesNotExist\b/);
  });
});

describe("P1 — the timer actually invokes the seam", () => {
  test("startOrphanReaperTimer calls eventLogRetention on a tick", async () => {
    const calls = [];
    let fire = null;
    const clock = {
      setInterval: (fn) => {
        fire = fn;
        return { id: 1 };
      },
      clearInterval: () => {},
    };
    const timer = startOrphanReaperTimer({
      enabled: true,
      intervalSeconds: 1,
      emit: async () => {},
      jobGc: async () => {},
      workerGc: async () => {},
      wtCleanupDrain: async () => {},
      eventLogRetention: async () => {
        calls.push("retention");
      },
      clock,
    });
    expect(fire).not.toBeNull();
    await fire();
    expect(calls).toEqual(["retention"]);
    timer.stop?.();
  });
});

describe("P1 — the bound sweep APPLIES, it does not dry-run forever", () => {
  // A fixture directory with one partition outside the derived window and one
  // inside it. Fixed clock is unnecessary: 2020 is outside any plausible window
  // and the current month is inside every one.
  function fakeFs(names, sizes = {}) {
    const unlinked = [];
    return {
      unlinked,
      fs: {
        existsSync: () => true,
        readdirSync: () => names,
        statSync: (p) => {
          const name = p.split("/").pop();
          return { size: sizes[name] ?? 0, isFile: () => !name.startsWith(".") };
        },
        unlinkSync: (p) => unlinked.push(p.split("/").pop()),
      },
    };
  }

  const currentMonth = `${new Date().getUTCFullYear()}-${String(new Date().getUTCMonth() + 1).padStart(2, "0")}.jsonl`;

  test("the production factory deletes an expired partition with no flags passed", async () => {
    const h = fakeFs(["2020-01.jsonl", currentMonth], { "2020-01.jsonl": 4096 });
    const sweep = createEventLogRetentionSweep({ eventsDir: "/events", fs: h.fs });
    const res = await sweep();
    expect(res.refused).toBeNull();
    expect(res.applied).toBe(true); // ← the half that was false before
    expect(h.unlinked).toEqual(["2020-01.jsonl"]);
    expect(res.reclaimedBytes).toBe(4096);
  });

  test("PLANTED CONTROL: it keeps the partition that is inside the window", () => {
    // The delete above must be a decision, not indiscriminate deletion.
    const h = fakeFs([currentMonth]);
    return createEventLogRetentionSweep({ eventsDir: "/events", fs: h.fs })().then((res) => {
      expect(res.removed).toEqual([]);
      expect(h.unlinked).toEqual([]);
    });
  });

  test("a missing events directory is a no-op, not a throw", async () => {
    const sweep = createEventLogRetentionSweep({
      eventsDir: "/nope",
      fs: { existsSync: () => false },
    });
    expect(await sweep()).toBeNull();
  });

  test("a throwing filesystem is swallowed and logged — retention never takes the tick down", async () => {
    const logged = [];
    const sweep = createEventLogRetentionSweep({
      eventsDir: "/events",
      log: { error: (o, m) => logged.push(m) },
      fs: {
        existsSync: () => true,
        readdirSync: () => {
          throw new Error("EIO");
        },
      },
    });
    expect(await sweep()).toBeNull();
    expect(logged.length).toBe(1);
  });
});

describe("P2 — rotation names the live writers actually emit are recognized", () => {
  // Derived from the emitters, not from a directory listing:
  //   lib/canonical-event.sh:784-785      .legacy.<YYYYMMDDTHHMMSSZ>.<pid>[.<n>]
  //   orch-monitor/lib/event-writer.ts:197 .legacy.<ISO with [:.]→->[.<n>]
  const REAL_ROTATIONS = [
    "2026-05.jsonl.legacy", // historical fixed name, on disk today
    "2026-05.jsonl.legacy.20260501T000000Z.12345", // bash, no collision
    "2026-05.jsonl.legacy.20260501T000000Z.12345.3", // bash, collision counter
    "2026-05.jsonl.legacy.2026-05-01T00-00-00-000Z", // TS, no collision
    "2026-05.jsonl.legacy.2026-05-01T00-00-00-000Z.7", // TS, collision counter
  ];

  test("every rotation shape both writers emit is prunable, not a refusal", async () => {
    const unlinked = [];
    const fs = {
      existsSync: () => true,
      readdirSync: () => REAL_ROTATIONS,
      statSync: () => ({ size: 1, isFile: () => true }),
      unlinkSync: (p) => unlinked.push(p.split("/").pop()),
    };
    const res = await createEventLogRetentionSweep({ eventsDir: "/events", fs })();
    // The whole point: NOT refused. Before this fix, any one of these made the
    // entire run refuse, so the job deleted nothing on every host that had ever
    // rotated a legacy month.
    expect(res.refused).toBeNull();
    expect(unlinked.sort()).toEqual([...REAL_ROTATIONS].sort());
  });

  test("PLANTED CONTROL: a genuinely foreign file STILL refuses the whole run", async () => {
    // The guard was fixed, not weakened.
    const unlinked = [];
    const fs = {
      existsSync: () => true,
      readdirSync: () => ["2020-01.jsonl", "2026-08.jsonl.gz"],
      statSync: () => ({ size: 1, isFile: () => true }),
      unlinkSync: (p) => unlinked.push(p),
    };
    const res = await createEventLogRetentionSweep({ eventsDir: "/events", fs })();
    expect(res.refused).toMatch(/unrecognized/);
    expect(unlinked).toEqual([]);
  });
});
