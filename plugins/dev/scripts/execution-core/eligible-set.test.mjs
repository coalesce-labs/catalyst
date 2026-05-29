// Unit tests for the execution-core eligible-set projection (CTL-535 Phase 3).
// Run: cd plugins/dev/scripts/execution-core && bun test eligible-set.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  setProjectEligible,
  removeTicket,
  dropProject,
  getEligibleSet,
  upsertTicket,
} from "./eligible-set.mjs";

// Keys touched by this suite — afterEach drops them so the module-level
// in-memory state does not leak between tests.
const TEST_KEYS = ["alpha", "beta", "gamma", "crashy"];

let catalystDir;
let eligibleDir;
let prevCatalystDir;

beforeEach(() => {
  prevCatalystDir = process.env.CATALYST_DIR;
  catalystDir = mkdtempSync(join(tmpdir(), "exec-core-elig-"));
  process.env.CATALYST_DIR = catalystDir;
  eligibleDir = join(catalystDir, "execution-core", "eligible");
});

afterEach(() => {
  for (const k of TEST_KEYS) {
    try {
      dropProject(k);
    } catch {
      /* not tracked — fine */
    }
  }
  if (prevCatalystDir === undefined) delete process.env.CATALYST_DIR;
  else process.env.CATALYST_DIR = prevCatalystDir;
  rmSync(catalystDir, { recursive: true, force: true });
});

const projFile = (key) => join(eligibleDir, `${key}.json`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("setProjectEligible", () => {
  test("writes eligible/<projectKey>.json atomically (tmp + rename, no leftover tmp)", () => {
    setProjectEligible(
      "alpha",
      [{ identifier: "A-1", state: "Todo", priority: 1 }],
      { source: "reconcile", query: { team: "A" } },
    );
    expect(existsSync(projFile("alpha"))).toBe(true);
    expect(existsSync(`${projFile("alpha")}.tmp`)).toBe(false);
    expect(() => JSON.parse(readFileSync(projFile("alpha"), "utf8"))).not.toThrow();
  });

  test("projection file shape: { projectKey, updatedAt, source, query, tickets }", () => {
    const query = { team: "A", status: "Todo" };
    setProjectEligible("alpha", [{ identifier: "A-1", state: "Todo", priority: 1 }], {
      source: "reconcile",
      query,
    });
    const doc = JSON.parse(readFileSync(projFile("alpha"), "utf8"));
    expect(doc.projectKey).toBe("alpha");
    expect(typeof doc.updatedAt).toBe("string");
    expect(doc.source).toBe("reconcile");
    expect(doc.query).toEqual(query);
    expect(Array.isArray(doc.tickets)).toBe(true);
    expect(doc.tickets[0].identifier).toBe("A-1");
  });

  test("tickets are sorted deterministically by identifier", () => {
    setProjectEligible(
      "alpha",
      [
        { identifier: "A-3", state: "Todo", priority: 1 },
        { identifier: "A-1", state: "Todo", priority: 1 },
        { identifier: "A-2", state: "Todo", priority: 1 },
      ],
      { source: "reconcile", query: {} },
    );
    const doc = JSON.parse(readFileSync(projFile("alpha"), "utf8"));
    expect(doc.tickets.map((t) => t.identifier)).toEqual(["A-1", "A-2", "A-3"]);
  });

  test("a second setProjectEligible with identical tickets does NOT rewrite the file (mtime unchanged)", async () => {
    const tickets = [{ identifier: "A-1", state: "Todo", priority: 1 }];
    setProjectEligible("alpha", tickets, { source: "reconcile", query: {} });
    const mtime1 = statSync(projFile("alpha")).mtimeMs;
    await sleep(15);
    setProjectEligible(
      "alpha",
      [{ identifier: "A-1", state: "Todo", priority: 1 }],
      { source: "reconcile", query: {} },
    );
    expect(statSync(projFile("alpha")).mtimeMs).toBe(mtime1);
  });

  test("a setProjectEligible with changed ticket content DOES rewrite the file", async () => {
    setProjectEligible("alpha", [{ identifier: "A-1", state: "Todo", priority: 1 }], {
      source: "reconcile",
      query: {},
    });
    const mtime1 = statSync(projFile("alpha")).mtimeMs;
    await sleep(15);
    setProjectEligible(
      "alpha",
      [
        { identifier: "A-1", state: "Todo", priority: 1 },
        { identifier: "A-2", state: "Todo", priority: 1 },
      ],
      { source: "reconcile", query: {} },
    );
    expect(statSync(projFile("alpha")).mtimeMs).toBeGreaterThan(mtime1);
  });
});

describe("removeTicket", () => {
  test("drops a ticket and rewrites the projection", async () => {
    setProjectEligible(
      "alpha",
      [
        { identifier: "A-1", state: "Todo", priority: 1 },
        { identifier: "A-2", state: "Todo", priority: 1 },
      ],
      { source: "reconcile", query: {} },
    );
    const mtime1 = statSync(projFile("alpha")).mtimeMs;
    await sleep(15);
    expect(removeTicket("alpha", "A-1")).toBe(true);
    const doc = JSON.parse(readFileSync(projFile("alpha"), "utf8"));
    expect(doc.tickets.map((t) => t.identifier)).toEqual(["A-2"]);
    expect(statSync(projFile("alpha")).mtimeMs).toBeGreaterThan(mtime1);
  });

  test("removeTicket on a ticket not in the set is a no-op (no rewrite)", async () => {
    setProjectEligible("alpha", [{ identifier: "A-1", state: "Todo", priority: 1 }], {
      source: "reconcile",
      query: {},
    });
    const mtime1 = statSync(projFile("alpha")).mtimeMs;
    await sleep(15);
    expect(removeTicket("alpha", "A-999")).toBe(false);
    expect(statSync(projFile("alpha")).mtimeMs).toBe(mtime1);
  });

  test("removeTicket on an untracked project is a safe no-op returning false", () => {
    expect(removeTicket("never-tracked", "X-1")).toBe(false);
  });
});

describe("dropProject", () => {
  test("deletes the in-memory entry and the projection file", () => {
    setProjectEligible("alpha", [{ identifier: "A-1", state: "Todo", priority: 1 }], {
      source: "reconcile",
      query: {},
    });
    expect(existsSync(projFile("alpha"))).toBe(true);
    dropProject("alpha");
    expect(existsSync(projFile("alpha"))).toBe(false);
    expect(getEligibleSet("alpha")).toEqual([]);
  });

  test("dropProject on an untracked project does not throw", () => {
    expect(() => dropProject("never-tracked")).not.toThrow();
  });
});

describe("getEligibleSet", () => {
  test("returns a copy, not the live internal structure", () => {
    setProjectEligible("alpha", [{ identifier: "A-1", state: "Todo", priority: 1 }], {
      source: "reconcile",
      query: {},
    });
    const got = getEligibleSet("alpha");
    got.push({ identifier: "A-99", state: "Todo", priority: 1 });
    got[0].state = "MUTATED";
    const fresh = getEligibleSet("alpha");
    expect(fresh).toHaveLength(1);
    expect(fresh[0].state).toBe("Todo");
  });

  test("returns [] for an untracked project", () => {
    expect(getEligibleSet("never-tracked")).toEqual([]);
  });
});

describe("atomic write durability", () => {
  test("a crash mid-write (rename fails) never leaves a partial <projectKey>.json", () => {
    // Make the projection path an existing non-empty directory so renameSync
    // (file -> non-empty dir) fails, simulating a crash between the tmp write
    // and the rename.
    mkdirSync(projFile("crashy"), { recursive: true });
    writeFileSync(join(projFile("crashy"), "sentinel"), "x");
    expect(() =>
      setProjectEligible(
        "crashy",
        [{ identifier: "C-1", state: "Todo", priority: 1 }],
        { source: "reconcile", query: {} },
      ),
    ).toThrow();
    // the path is still the directory — never a half-written JSON file
    expect(statSync(projFile("crashy")).isDirectory()).toBe(true);
    // the tmp scratch file was cleaned up
    expect(existsSync(`${projFile("crashy")}.tmp`)).toBe(false);
    // remove the stand-in directory so the afterEach dropProject is quiet
    rmSync(projFile("crashy"), { recursive: true, force: true });
  });
});

// CTL-681: upsertTicket — insert or merge a single ticket into the eligible set.
describe("upsertTicket (CTL-681)", () => {
  test("adds a brand-new ticket to an empty project and writes the projection", () => {
    upsertTicket("beta", { identifier: "B-1", state: "Todo", priority: 2 });
    const set = getEligibleSet("beta");
    expect(set.map((t) => t.identifier)).toEqual(["B-1"]);
    expect(existsSync(projFile("beta"))).toBe(true);
  });

  test("adds a ticket to an existing project alongside prior tickets (sorted)", () => {
    setProjectEligible("beta", [{ identifier: "B-2", state: "Todo", priority: 1 }], {
      source: "reconcile",
      query: {},
    });
    upsertTicket("beta", { identifier: "B-1", state: "Todo", priority: 2 });
    expect(getEligibleSet("beta").map((t) => t.identifier)).toEqual(["B-1", "B-2"]);
  });

  test("merging over an existing ticket preserves relations, updates state/priority", () => {
    setProjectEligible(
      "beta",
      [{ identifier: "B-1", state: "Todo", priority: 1, relations: [{ id: "r1" }] }],
      { source: "reconcile", query: {} }
    );
    upsertTicket("beta", { identifier: "B-1", state: "In Progress", priority: 2 });
    const ticket = getEligibleSet("beta").find((t) => t.identifier === "B-1");
    expect(ticket.state).toBe("In Progress");
    expect(ticket.priority).toBe(2);
    expect(ticket.relations).toEqual([{ id: "r1" }]);
  });

  test("creates the project entry if absent (new projectKey)", () => {
    expect(getEligibleSet("gamma")).toEqual([]);
    upsertTicket("gamma", { identifier: "G-1", state: "Todo", priority: 1 });
    expect(getEligibleSet("gamma").map((t) => t.identifier)).toEqual(["G-1"]);
  });

  test("stamps source = 'event'", () => {
    upsertTicket("beta", { identifier: "B-1", state: "Todo", priority: 1 });
    const doc = JSON.parse(readFileSync(projFile("beta"), "utf8"));
    expect(doc.source).toBe("event");
  });

  test("skip-write when [identifier, state, priority] tuple is unchanged (mtime stable)", async () => {
    setProjectEligible("beta", [{ identifier: "B-1", state: "Todo", priority: 1 }], {
      source: "reconcile",
      query: {},
    });
    const mtime1 = statSync(projFile("beta")).mtimeMs;
    await sleep(15);
    upsertTicket("beta", { identifier: "B-1", state: "Todo", priority: 1 });
    expect(statSync(projFile("beta")).mtimeMs).toBe(mtime1);
  });

  test("rewrites the projection when upserted ticket changes state", async () => {
    setProjectEligible("beta", [{ identifier: "B-1", state: "Todo", priority: 1 }], {
      source: "reconcile",
      query: {},
    });
    const mtime1 = statSync(projFile("beta")).mtimeMs;
    await sleep(15);
    upsertTicket("beta", { identifier: "B-1", state: "In Progress", priority: 1 });
    expect(statSync(projFile("beta")).mtimeMs).toBeGreaterThan(mtime1);
  });
});
