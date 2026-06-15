// free-slots-shadow.test.mjs — CTL-935 Phase 2: the free-slots / R8 shadow
// comparator.  Mirrors advance-shadow.test.mjs harness style.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { openBeliefsDb } from "./schema.mjs";
import { evaluateBeliefs } from "./rules.mjs";
import {
  readFreeSlotsBelief,
  compareFreeSlots,
  runFreeSlotsShadow,
} from "./free-slots-shadow.mjs";

const NOW = 1781030108000;
const HOST = "mini";

const tmps = [];
function scratch() {
  const d = mkdtempSync(join(tmpdir(), "ctl935-fs-shadow-"));
  tmps.push(d);
  return d;
}
let db;
beforeEach(() => {
  db = openBeliefsDb({ path: join(scratch(), "b.db") });
});
afterEach(() => {
  try { db.close(); } catch { /* */ }
  while (tmps.length) {
    try { rmSync(tmps.pop(), { recursive: true, force: true }); } catch { /* */ }
  }
});

function tick(host = HOST) {
  db.run("INSERT INTO tick (now_ms, host) VALUES (?, ?)", [NOW, host]);
  return db.query("SELECT last_insert_rowid() AS id").get().id;
}

function seedFreeSlotsBeliefDirectly(tickId, val) {
  db.run(
    "INSERT OR IGNORE INTO belief (tick_id, stratum, name, subject, value, rule_id, source_fact_ids) VALUES (?, 3, 'free_slots', ?, ?, 'R8', '[]')",
    [tickId, `host:${HOST}`, JSON.stringify(val)],
  );
}

describe("readFreeSlotsBelief", () => {
  test("returns the full belief value object for the host row", () => {
    const t = tick();
    const val = {
      free_slots: 6, by_lease: 6, by_session_cap: 9,
      max_parallel: 6, session_cap: 10,
      lease_valid_count: 0, bg_session_count: 1,
    };
    seedFreeSlotsBeliefDirectly(t, val);
    const got = readFreeSlotsBelief(db, t);
    expect(got).not.toBeNull();
    expect(got.free_slots).toBe(6);
    expect(got.by_lease).toBe(6);
    expect(got.bg_session_count).toBe(1);
    expect(got.max_parallel).toBe(6);
    expect(got.lease_valid_count).toBe(0);
  });

  test("returns null on missing db", () => {
    expect(readFreeSlotsBelief(null, 1)).toBeNull();
  });

  test("returns null on null tickId", () => {
    const t = tick();
    seedFreeSlotsBeliefDirectly(t, { free_slots: 4 });
    expect(readFreeSlotsBelief(db, null)).toBeNull();
  });

  test("returns null when no free_slots row for that tick", () => {
    const t = tick();
    expect(readFreeSlotsBelief(db, t)).toBeNull();
  });

  test("is consistent with real evaluateBeliefs on a wedge-fleet tick", () => {
    const t = tick();
    // Seed one background obs_agent (wedge scenario: bg_session_count=1, no lease)
    db.run("INSERT INTO obs_agent (tick_id, session_id, short_id, kind, status) VALUES (?, 'sid1', 'abc1', 'background', 'idle')", [t]);
    evaluateBeliefs(db, t);
    const got = readFreeSlotsBelief(db, t);
    expect(got).not.toBeNull();
    expect(got.bg_session_count).toBe(1);
    expect(got.lease_valid_count).toBe(0);
    expect(got.free_slots).toBe(6); // min(6-0, 10-1)=min(6,9)=6
  });
});

describe("compareFreeSlots — pure comparison", () => {
  test("returns null when procedural === belief.free_slots (agreement)", () => {
    const belief = { free_slots: 6, max_parallel: 6, session_cap: 10, lease_valid_count: 0, bg_session_count: 1 };
    expect(compareFreeSlots({ proceduralFreeSlots: 6, belief, host: HOST })).toBeNull();
  });

  test("returns null when both clamp to 0 (agreement even if components differ)", () => {
    const belief = { free_slots: 0, max_parallel: 6, session_cap: 10, lease_valid_count: 6, bg_session_count: 0 };
    expect(compareFreeSlots({ proceduralFreeSlots: 0, belief, host: HOST })).toBeNull();
  });

  test("returns disagreement record when procedural=4, belief.free_slots=0 (wedge-fleet)", () => {
    const belief = { free_slots: 0, max_parallel: 6, session_cap: 10, lease_valid_count: 0, bg_session_count: 10 };
    const rec = compareFreeSlots({ proceduralFreeSlots: 4, belief, host: HOST });
    expect(rec).not.toBeNull();
    expect(rec.procedural).toBe(4);
    expect(rec.belief).toBe(0);
    expect(rec.host).toBe(HOST);
  });

  test("sets differingInput.name='max_parallel' when only max_parallel differs (cfg-staleness)", () => {
    // belief sees max_parallel=6 (from cfg); procedural used max_parallel=2 (config override)
    const belief = {
      free_slots: 6, max_parallel: 6, session_cap: 10,
      lease_valid_count: 0, bg_session_count: 0,
    };
    // Procedural sees freeSlots=2 (because its maxParallel is 2, not 6)
    const rec = compareFreeSlots({
      proceduralFreeSlots: 2,
      belief,
      host: HOST,
      proceduralInputs: { maxParallel: 2, inFlightCount: 0, livenessFresh: true, draining: false },
    });
    expect(rec).not.toBeNull();
    expect(rec.differingInput.name).toBe("max_parallel");
    expect(rec.differingInput.procedural).toBe(2);
    expect(rec.differingInput.belief).toBe(6);
  });

  test("sets differingInput.name='bg_session_count' when max_parallel matches but inFlightCount < bg_session_count (CTL-657)", () => {
    // Procedural liveness-filters: 4 alive agents → inFlightCount=4 → freeSlots=2
    // Belief counts raw obs_agent: bg_session_count=6 → by_session_cap=4 → free_slots=4
    const belief = {
      free_slots: 4, max_parallel: 6, session_cap: 10,
      lease_valid_count: 0, bg_session_count: 6,
    };
    const rec = compareFreeSlots({
      proceduralFreeSlots: 2,
      belief,
      host: HOST,
      proceduralInputs: { maxParallel: 6, inFlightCount: 4, livenessFresh: true, draining: false },
    });
    expect(rec).not.toBeNull();
    expect(rec.differingInput.name).toBe("bg_session_count");
  });
});

describe("runFreeSlotsShadow — driver behaviour", () => {
  test("appends beliefs.free_slots_shadow.disagree event AND writes agree=0 row on disagreement", () => {
    const t = tick();
    const belief = {
      free_slots: 0, max_parallel: 6, session_cap: 10,
      lease_valid_count: 0, bg_session_count: 10,
    };
    seedFreeSlotsBeliefDirectly(t, belief);
    const events = [];
    const written = [];
    runFreeSlotsShadow(db, t, {
      proceduralFreeSlots: 4,
      proceduralInputs: { maxParallel: 6, inFlightCount: 4, livenessFresh: true, draining: false },
      appendEvent: (e) => events.push(e),
      writeComparison: (rec) => written.push(rec),
    });
    expect(events.filter((e) => e["event.name"] === "beliefs.free_slots_shadow.disagree")).toHaveLength(1);
    const ev = events[0];
    expect(ev.payload.procedural).toBe(4);
    expect(ev.payload.belief).toBe(0);
    expect(written).toHaveLength(1);
    expect(written[0].agree).toBe(0);
    expect(written[0].dimension).toBe("free_slots");
    expect(written[0].ruleId).toBe("R8");
    expect("rules_sha" in ev.payload).toBe(true);
  });

  test("on agreement writes agree=1 and emits NO disagree event", () => {
    const t = tick();
    const belief = {
      free_slots: 6, max_parallel: 6, session_cap: 10,
      lease_valid_count: 0, bg_session_count: 1,
    };
    seedFreeSlotsBeliefDirectly(t, belief);
    const events = [];
    const written = [];
    runFreeSlotsShadow(db, t, {
      proceduralFreeSlots: 6,
      proceduralInputs: { maxParallel: 6, inFlightCount: 1, livenessFresh: true, draining: false },
      appendEvent: (e) => events.push(e),
      writeComparison: (rec) => written.push(rec),
    });
    expect(events.filter((e) => e["event.name"] === "beliefs.free_slots_shadow.disagree")).toHaveLength(0);
    expect(written).toHaveLength(1);
    expect(written[0].agree).toBe(1);
  });

  test("disagreement payload contains tickId, host, both free_slots values, differingInput", () => {
    const t = tick();
    const belief = { free_slots: 0, max_parallel: 6, session_cap: 10, lease_valid_count: 0, bg_session_count: 10 };
    seedFreeSlotsBeliefDirectly(t, belief);
    const events = [];
    runFreeSlotsShadow(db, t, {
      proceduralFreeSlots: 4,
      appendEvent: (e) => events.push(e),
    });
    const payload = events[0].payload;
    expect(typeof payload.tickId).toBe("number");
    expect(payload.host).toBe(HOST);
    expect(typeof payload.procedural).toBe("number");
    expect(typeof payload.belief).toBe("number");
    expect(payload.differingInput).toBeTruthy();
  });

  test("returns {agree:0,disagree:0} without throwing when db is null", () => {
    expect(() => {
      const r = runFreeSlotsShadow(null, 1, { proceduralFreeSlots: 4 });
      expect(r.agree).toBe(0);
      expect(r.disagree).toBe(0);
    }).not.toThrow();
  });

  test("returns {agree:0,disagree:0} without throwing when tickId is null", () => {
    const t = tick();
    expect(() => {
      const r = runFreeSlotsShadow(db, null, { proceduralFreeSlots: 4 });
      expect(r.agree).toBe(0);
      expect(r.disagree).toBe(0);
    }).not.toThrow();
  });

  test("a throwing writeComparison does NOT abort the comparator (shadow contract)", () => {
    const t = tick();
    const belief = { free_slots: 0, max_parallel: 6, session_cap: 10, lease_valid_count: 0, bg_session_count: 10 };
    seedFreeSlotsBeliefDirectly(t, belief);
    const events = [];
    expect(() => {
      runFreeSlotsShadow(db, t, {
        proceduralFreeSlots: 4,
        appendEvent: (e) => events.push(e),
        writeComparison: () => { throw new Error("store broke"); },
      });
    }).not.toThrow();
    expect(events.filter((e) => e["event.name"] === "beliefs.free_slots_shadow.disagree")).toHaveLength(1);
  });
});
