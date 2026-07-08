// linear-cli.test.mjs — CTL-1391. Tests for the catalyst-linear driver.
//
// Strategy: pure-unit tests for the logic-dense seams (parseArgs, resolveReplicaMode,
// normalizeDetail) + integration tests that exercise main() end-to-end against (a) a
// REAL minimal bun:sqlite replica seeded from an inline fixture (the read-model query
// path) and (b) a FAKE `linearis` on PATH (the fallback path). No @catalyst-cloud/schema
// dependency (would pull drizzle onto worker nodes) — the fixture hand-rolls only the
// tables buildIssueDetail/buildIssueActivity read.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync, chmodSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseArgs, resolveReplicaMode, normalizeDetail, main } from "./linear-cli.mjs";

// ── fixtures ───────────────────────────────────────────────────────────────
// Minimal schema covering exactly what buildIssueDetail + buildIssueActivity SELECT.
// Conditional sub-queries (projects/cycles/users) are skipped for a null-FK issue, so
// those tables are omitted; the always-run list queries (comments/labels/relations/
// issue_history) need their tables present even when empty.
const SCHEMA = `
CREATE TABLE issues (
  id TEXT PRIMARY KEY, identifier TEXT, title TEXT, description TEXT, state TEXT,
  assignee TEXT, assignee_id TEXT, priority INTEGER, estimate REAL,
  project_id TEXT, cycle_id TEXT, team_id TEXT,
  delegate_id TEXT, delegate_name TEXT, bot_actor_name TEXT, bot_actor_type TEXT, bot_actor_sub_type TEXT,
  parent_id TEXT, parent_identifier TEXT,
  url TEXT, started_at INTEGER, completed_at INTEGER, canceled_at INTEGER, created_at INTEGER, due_date TEXT,
  priority_label TEXT, sort_order REAL, updated_at INTEGER, removed_at INTEGER, branch_name TEXT
);
CREATE TABLE comments (
  id TEXT PRIMARY KEY, issue_id TEXT, body TEXT, author_id TEXT, author_name TEXT,
  author_avatar_url TEXT, is_bot INTEGER, parent_id TEXT, updated_at INTEGER, removed_at INTEGER
);
CREATE TABLE labels (id TEXT PRIMARY KEY, name TEXT, color TEXT, removed_at INTEGER);
CREATE TABLE issue_labels (issue_id TEXT, label_id TEXT);
CREATE TABLE relations (type TEXT, issue_identifier TEXT, related_identifier TEXT);
CREATE TABLE issue_history (
  id TEXT PRIMARY KEY, issue_id TEXT, actor_id TEXT, created_at INTEGER, from_state TEXT, to_state TEXT,
  from_assignee_id TEXT, to_assignee_id TEXT, from_priority INTEGER, to_priority INTEGER,
  from_estimate REAL, to_estimate REAL, from_title TEXT, to_title TEXT,
  from_cycle_id TEXT, to_cycle_id TEXT, from_project_id TEXT, to_project_id TEXT,
  from_parent_id TEXT, to_parent_id TEXT, from_team_id TEXT, to_team_id TEXT,
  from_due_date TEXT, to_due_date TEXT, added_label_ids TEXT, removed_label_ids TEXT,
  updated_description INTEGER, archived INTEGER, auto_archived INTEGER, auto_closed INTEGER, trashed INTEGER
);
`;

function seedReplica(dbPath, { updatedAt = Date.now() } = {}) {
  const db = new Database(dbPath);
  db.run("PRAGMA journal_mode = WAL");
  for (const stmt of SCHEMA.split(";")) { const s = stmt.trim(); if (s) db.run(s); }
  db.run(
    `INSERT INTO issues (id, identifier, title, description, state, team_id, priority, estimate,
       url, due_date, created_at, updated_at, removed_at, branch_name)
     VALUES ('uuid-1', 'CTL-TEST', 'Test issue', 'A description', 'Implement', 'team-uuid', 2, 3,
       'https://linear.app/x/issue/CTL-TEST', '2026-07-01', 1782700000000, ?, NULL, 'ryan/ctl-test-slug')`,
    updatedAt,
  );
  db.run("INSERT INTO labels (id, name, color, removed_at) VALUES ('lbl-1','orchestrator','#fff',NULL)");
  db.run("INSERT INTO issue_labels (issue_id, label_id) VALUES ('uuid-1','lbl-1')");
  // forward edge: CTL-TEST blocks CTL-OTHER; inverse edge: CTL-DEP blocks CTL-TEST.
  db.run("INSERT INTO relations (type, issue_identifier, related_identifier) VALUES ('blocks','CTL-TEST','CTL-OTHER')");
  db.run("INSERT INTO relations (type, issue_identifier, related_identifier) VALUES ('blocks','CTL-DEP','CTL-TEST')");
  db.run("INSERT INTO comments (id, issue_id, body, updated_at, removed_at) VALUES ('cmt-1','uuid-1','hello',1782700001000,NULL)");
  db.close();
}

// Write a fake `linearis` onto PATH. exitCode 0 → emits `payload`; non-zero → fails.
function installFakeLinearis(dir, { payload, exitCode = 0 } = {}) {
  const script = join(dir, "linearis");
  const body = `#!/usr/bin/env bash\ncat <<'JSON'\n${JSON.stringify(payload ?? {})}\nJSON\nexit ${exitCode}\n`;
  writeFileSync(script, body);
  chmodSync(script, 0o755);
  process.env.PATH = `${dir}:${process.env.PATH}`;
}

// Fake `linearis` that echoes the argv it received (as `_args`) so a test can assert
// flag passthrough. `$*` is the space-joined args (e.g. "issues read CTL-TEST --x").
function installArgEchoLinearis(dir) {
  const script = join(dir, "linearis");
  const body = `#!/usr/bin/env bash\nargs="$*"\ncat <<JSON\n{"identifier":"CTL-TEST","_args":"$args"}\nJSON\n`;
  writeFileSync(script, body);
  chmodSync(script, 0o755);
  process.env.PATH = `${dir}:${process.env.PATH}`;
}

// Fake `linearis` that sleeps `ms` before emitting — to prove the read cap fires
// while list/search passthrough stays uncapped.
function installSlowLinearis(dir, ms) {
  const script = join(dir, "linearis");
  const body = `#!/usr/bin/env bash\nsleep ${ms / 1000}\ncat <<'JSON'\n{"identifier":"CTL-SLOW","nodes":[]}\nJSON\n`;
  writeFileSync(script, body);
  chmodSync(script, 0o755);
  process.env.PATH = `${dir}:${process.env.PATH}`;
}

// Run main(argv), capturing stdout. Returns { code, out (parsed JSON or null), raw }.
async function runMain(argv) {
  const chunks = [];
  const errChunks = [];
  const origWrite = process.stdout.write;
  const origErr = process.stderr.write;
  process.stdout.write = (s) => { chunks.push(typeof s === "string" ? s : s.toString()); return true; };
  process.stderr.write = (s) => { errChunks.push(typeof s === "string" ? s : s.toString()); return true; };
  let code;
  try {
    code = await main(argv);
  } finally {
    process.stdout.write = origWrite;
    process.stderr.write = origErr;
  }
  const raw = chunks.join("");
  const err = errChunks.join("");
  let out = null;
  try { out = JSON.parse(raw); } catch { /* non-JSON (e.g. usage) */ }
  return { code, out, raw, err };
}

// ── env isolation ────────────────────────────────────────────────────────
let tmp;
const SAVED = {};
const ENV_KEYS = ["CATALYST_LINEAR_REPLICA", "CATALYST_REPLICA_DB", "CATALYST_LINEAR_REPLICA_STALE_MS", "CATALYST_LINEARIS_TIMEOUT_MS", "CATALYST_LAYER2_CONFIG_FILE", "PATH", "CATALYST_DIR"];
beforeEach(() => {
  for (const k of ENV_KEYS) SAVED[k] = process.env[k];
  tmp = mkdtempSync(join(tmpdir(), "catalyst-linear-test-"));
  // Point CATALYST_DIR somewhere empty so the default replica path is absent unless we set it.
  process.env.CATALYST_DIR = join(tmp, "no-catalyst");
  delete process.env.CATALYST_LINEAR_REPLICA;
  delete process.env.CATALYST_REPLICA_DB;
  delete process.env.CATALYST_LINEAR_REPLICA_STALE_MS;
  delete process.env.CATALYST_LINEARIS_TIMEOUT_MS;
  delete process.env.CATALYST_LAYER2_CONFIG_FILE;
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
});

// ── parseArgs ──────────────────────────────────────────────────────────────
describe("parseArgs", () => {
  test("read with id", () => {
    expect(parseArgs(["read", "CTL-1"])).toEqual({ cmd: "read", positionals: ["CTL-1"], flags: {} });
  });
  test("list with flags (space + equals)", () => {
    const p = parseArgs(["list", "--team", "CTL", "--limit=5"]);
    expect(p.cmd).toBe("list");
    expect(p.flags).toEqual({ team: "CTL", limit: "5" });
  });
  test("search query + flag", () => {
    const p = parseArgs(["search", "auth bug", "--team", "CTL"]);
    expect(p).toEqual({ cmd: "search", positionals: ["auth bug"], flags: { team: "CTL" } });
  });
});

// ── resolveReplicaMode ──────────────────────────────────────────────────────
describe("resolveReplicaMode", () => {
  test('env "on"/"1" → on; "0"/"off"/garbage → off', () => {
    expect(resolveReplicaMode({ CATALYST_LINEAR_REPLICA: "on" })).toBe("on");
    expect(resolveReplicaMode({ CATALYST_LINEAR_REPLICA: "1" })).toBe("on");
    expect(resolveReplicaMode({ CATALYST_LINEAR_REPLICA: "0" })).toBe("off");
    expect(resolveReplicaMode({ CATALYST_LINEAR_REPLICA: "off" })).toBe("off");
    expect(resolveReplicaMode({ CATALYST_LINEAR_REPLICA: "maybe" })).toBe("off");
  });
  // NOTE: os.homedir() ignores process.env.HOME on macOS, so the Layer-2 path is
  // tested via the injectable cfgPathOverride rather than redirecting HOME.
  test("unset + Layer-2 config absent → off", () => {
    expect(resolveReplicaMode({}, join(tmp, "nope.json"))).toBe("off");
  });
  test('unset + Layer-2 mode:"on" → on', () => {
    const cfg = join(tmp, "config-on.json");
    writeFileSync(cfg, JSON.stringify({ catalyst: { linearReplica: { mode: "on" } } }));
    expect(resolveReplicaMode({}, cfg)).toBe("on");
  });
  test("unset + Layer-2 present but mode unset → off", () => {
    const cfg = join(tmp, "config-off.json");
    writeFileSync(cfg, JSON.stringify({ catalyst: {} }));
    expect(resolveReplicaMode({}, cfg)).toBe("off");
  });
  // Codex P2: honor CATALYST_LAYER2_CONFIG_FILE for parity with config.mjs —
  // a node launched with a non-default Layer-2 path resolves mode from THAT file.
  test('unset + CATALYST_LAYER2_CONFIG_FILE → mode:"on" → on', () => {
    const cfg = join(tmp, "layer2-on.json");
    writeFileSync(cfg, JSON.stringify({ catalyst: { linearReplica: { mode: "on" } } }));
    expect(resolveReplicaMode({ CATALYST_LAYER2_CONFIG_FILE: cfg })).toBe("on");
  });
  test("cfgPathOverride beats CATALYST_LAYER2_CONFIG_FILE", () => {
    const override = join(tmp, "override-off.json");
    writeFileSync(override, JSON.stringify({ catalyst: {} }));
    const envFile = join(tmp, "env-on.json");
    writeFileSync(envFile, JSON.stringify({ catalyst: { linearReplica: { mode: "on" } } }));
    expect(resolveReplicaMode({ CATALYST_LAYER2_CONFIG_FILE: envFile }, override)).toBe("off");
  });
});

// ── normalizeDetail (the transform; fake view + fake sql) ───────────────────
describe("normalizeDetail", () => {
  // fake sql.exec(query, ...binds).toArray() — returns canned rows for the two
  // parity completions (inverseRelations, branch_name).
  const fakeSql = {
    exec(query) {
      if (/related_identifier = \?/.test(query)) {
        return { toArray: () => [{ type: "blocks", issue_identifier: "CTL-DEP" }] };
      }
      if (/branch_name/.test(query)) {
        return { toArray: () => [{ branch_name: "ryan/ctl-x" }] };
      }
      return { toArray: () => [] };
    },
  };
  const view = {
    id: "uuid-9", identifier: "CTL-9", title: "T", description: "D", priority: 1, estimate: 2,
    due_date: "2026-07-04", created_at: 1782700000000, updated_at: 1782700500000,
    url: "https://linear/CTL-9", state: "Implement",
    assignee_id: "u1", assignee_name: "Ryan", assignee: "ryan",
    team_id: "team-1", project_id: "p1", project_name: "Proj",
    cycle_id: "c1", cycle_number: 7, parent_id: "par1", parent_identifier: "CTL-1",
    labels: [{ id: "l1", name: "bug", color: "#f00" }],
    relations: [{ type: "blocks", related_identifier: "CTL-OTHER" }],
    comments: [{ id: "cm1", body: "hi" }],
  };
  const out = normalizeDetail(view, fakeSql);

  test("dueDate passes through (no Date.parse) and timestamps become ISO", () => {
    expect(out.dueDate).toBe("2026-07-04");
    expect(out.createdAt).toBe(new Date(1782700000000).toISOString());
    expect(out.updatedAt).toBe(new Date(1782700500000).toISOString());
  });
  test("state is {name} (no state.id); team is {id} only", () => {
    expect(out.state).toEqual({ name: "Implement" });
    expect(out.team).toEqual({ id: "team-1" });
  });
  test("assignee/project/cycle/parent shapes", () => {
    expect(out.assignee).toEqual({ id: "u1", name: "Ryan" });
    expect(out.project).toEqual({ id: "p1", name: "Proj" });
    expect(out.cycle).toEqual({ id: "c1", name: null, number: 7 });
    expect(out.parent).toEqual({ id: "par1", identifier: "CTL-1", title: null });
  });
  test("labels + forward relations mapped; inverseRelations + branchName from the second queries", () => {
    expect(out.labels.nodes).toEqual([{ id: "l1", name: "bug" }]);
    expect(out.relations.nodes).toEqual([{ type: "blocks", relatedIssue: { identifier: "CTL-OTHER" } }]);
    expect(out.inverseRelations.nodes).toEqual([{ type: "blocks", issue: { identifier: "CTL-DEP" } }]);
    expect(out.branchName).toBe("ryan/ctl-x");
  });
  test("null FKs → null shapes (not fabricated)", () => {
    const bare = normalizeDetail({ id: "x", identifier: "CTL-0", state: "Backlog" }, { exec: () => ({ toArray: () => [] }) });
    expect(bare.assignee).toBeNull();
    expect(bare.project).toBeNull();
    expect(bare.cycle).toBeNull();
    expect(bare.parent).toBeNull();
    expect(bare.inverseRelations.nodes).toEqual([]);
    expect(bare.branchName).toBeNull();
  });
});

// ── write rejection (node-safe path; no replica/cloud import reached) ────────
describe("write rejection", () => {
  for (const verb of ["create", "update", "move", "comment", "estimate", "label", "delete", "assign"]) {
    test(`rejects '${verb}' with exit 1`, async () => {
      const { code, err } = await runMain([verb, "CTL-1"]);
      expect(code).toBe(1);
      expect(JSON.parse(err.trim()).error).toContain("read-only");
    });
  }
});

// ── fallback to linearis (no replica / mode off) ────────────────────────────
describe("linearis fallback", () => {
  test("mode off → linearis, replica never consulted", async () => {
    installFakeLinearis(tmp, { payload: { identifier: "CTL-1", state: { name: "Todo" }, _sentinel: "linearis" } });
    // mode unset → off; even if a DB existed it would be skipped.
    const { code, out } = await runMain(["read", "CTL-1"]);
    expect(code).toBe(0);
    expect(out._meta.source).toBe("linearis");
    expect(out._meta.replica_mode).toBe("off");
    expect(out.identifier).toBe("CTL-1");
  });

  test("mode on but replica file absent → linearis (replica_skip=replica-absent)", async () => {
    installFakeLinearis(tmp, { payload: { identifier: "CTL-2", state: { name: "Backlog" } } });
    process.env.CATALYST_LINEAR_REPLICA = "on";
    process.env.CATALYST_REPLICA_DB = join(tmp, "does-not-exist.db");
    const { out } = await runMain(["read", "CTL-2"]);
    expect(out._meta.source).toBe("linearis");
    expect(out._meta.replica_skip).toBe("replica-absent");
  });
});

// ── replica HIT / MISS / STALE (real bun:sqlite + real read-model) ──────────
describe("replica reads", () => {
  test("HIT: fresh replica + mode on → reads replica, NOT linearis", async () => {
    const dbPath = join(tmp, "catalyst-replica.db");
    seedReplica(dbPath); // updated_at = now, file mtime = now → fresh
    process.env.CATALYST_LINEAR_REPLICA = "on";
    process.env.CATALYST_REPLICA_DB = dbPath;
    // A sentinel fake linearis: if the replica path is broken and we fall back,
    // the sentinel surfaces and the assertions fail cleanly (no process death).
    installFakeLinearis(tmp, { payload: { identifier: "SENTINEL-LINEARIS", state: { name: "x" } } });

    const { code, out } = await runMain(["read", "CTL-TEST"]);
    expect(code).toBe(0);
    expect(out._meta.source).toBe("replica");
    expect(out.identifier).toBe("CTL-TEST");
    expect(out.title).toBe("Test issue");
    expect(out.description).toBe("A description");
    expect(out.state).toEqual({ name: "Implement" });
    expect(out.dueDate).toBe("2026-07-01");
    expect(out.branchName).toBe("ryan/ctl-test-slug");
    expect(out.labels.nodes).toEqual([{ id: "lbl-1", name: "orchestrator" }]);
    // forward edge (CTL-TEST blocks CTL-OTHER) + inverse edge (CTL-DEP blocks CTL-TEST)
    expect(out.relations.nodes).toEqual([{ type: "blocks", relatedIssue: { identifier: "CTL-OTHER" } }]);
    expect(out.inverseRelations.nodes).toEqual([{ type: "blocks", issue: { identifier: "CTL-DEP" } }]);
    expect(out.comments.nodes).toEqual([{ id: "cmt-1", body: "hello" }]);
    expect(out._meta.replica_mode).toBe("on");
    expect(typeof out._meta.replica_staleness_ms).toBe("number");
    expect(out._meta.replica_row_count).toBe(1);
  });

  test("per-id MISS: replica fresh but id absent → linearis_miss", async () => {
    const dbPath = join(tmp, "catalyst-replica.db");
    seedReplica(dbPath);
    process.env.CATALYST_LINEAR_REPLICA = "on";
    process.env.CATALYST_REPLICA_DB = dbPath;
    installFakeLinearis(tmp, { payload: { identifier: "CTL-ABSENT", state: { name: "Backlog" } } });
    const { out } = await runMain(["read", "CTL-ABSENT"]);
    expect(out._meta.source).toBe("linearis_miss");
    expect(out.identifier).toBe("CTL-ABSENT");
  });

  test("STALE: old file mtime → linearis (skip=stale)", async () => {
    const dbPath = join(tmp, "catalyst-replica.db");
    seedReplica(dbPath, { updatedAt: Date.now() });
    // age the DB AND its WAL sidecar far beyond the threshold — the gate takes the
    // freshest of the DB + a non-empty -wal (WAL-mode writes land in -wal), so aging
    // only .db would (correctly) still read fresh from a populated sidecar.
    const old = (Date.now() - 3_600_000) / 1000;
    for (const ext of ["", "-wal", "-shm"]) { try { utimesSync(dbPath + ext, old, old); } catch { /* sidecar absent */ } }
    process.env.CATALYST_LINEAR_REPLICA = "on";
    process.env.CATALYST_REPLICA_DB = dbPath;
    process.env.CATALYST_LINEAR_REPLICA_STALE_MS = "300000";
    installFakeLinearis(tmp, { payload: { identifier: "CTL-TEST", state: { name: "Implement" } } });
    const { out } = await runMain(["read", "CTL-TEST"]);
    expect(out._meta.source).toBe("linearis");
    expect(out._meta.replica_skip).toBe("stale");
  });

  // Codex P2: a read-only consumer opening a checkpointed DB can create FRESH but
  // EMPTY -wal/-shm sidecars. The gate must ignore them (empty -wal + -shm entirely)
  // so a long-dead replica can't be made to look fresh by a mere reader open.
  test("WAL spoof-resistance: stale .db + freshly-touched EMPTY -wal/-shm → still stale", async () => {
    const dbPath = join(tmp, "catalyst-replica.db");
    seedReplica(dbPath, { updatedAt: Date.now() });
    const oldSec = (Date.now() - 3_600_000) / 1000; // writer dead an hour ago
    utimesSync(dbPath, oldSec, oldSec);
    const nowSec = Date.now() / 1000;
    for (const ext of ["-wal", "-shm"]) {
      writeFileSync(dbPath + ext, ""); // zero-length reader artifact
      utimesSync(dbPath + ext, nowSec, nowSec); // bumped to NOW
    }
    process.env.CATALYST_LINEAR_REPLICA = "on";
    process.env.CATALYST_REPLICA_DB = dbPath;
    process.env.CATALYST_LINEAR_REPLICA_STALE_MS = "300000";
    installFakeLinearis(tmp, { payload: { identifier: "CTL-TEST", state: { name: "Implement" } } });
    const { out } = await runMain(["read", "CTL-TEST"]);
    expect(out._meta.source).toBe("linearis");
    expect(out._meta.replica_skip).toBe("stale");
  });

  // Codex P2: read flags (e.g. --with-attachments, used by phase-research) must
  // reach linearis unchanged. The replica serves only the flagless detail shape, so
  // a flagged read bypasses the replica entirely (parity > acceleration).
  test("read flags bypass a FRESH replica → linearis passthrough preserves the flag", async () => {
    const dbPath = join(tmp, "catalyst-replica.db");
    seedReplica(dbPath); // fresh + mode on → would normally HIT
    process.env.CATALYST_LINEAR_REPLICA = "on";
    process.env.CATALYST_REPLICA_DB = dbPath;
    installArgEchoLinearis(tmp);
    const { code, out } = await runMain(["read", "CTL-TEST", "--with-attachments"]);
    expect(code).toBe(0);
    expect(out._meta.source).toBe("linearis"); // replica bypassed despite being fresh
    expect(out._meta.replica_skip).toBe("read-flags");
    expect(out._args).toBe("issues read CTL-TEST --with-attachments");
  });
});

// ── list / search passthrough + error paths ─────────────────────────────────
describe("list / search / errors", () => {
  test("list → linearis passthrough with _meta annotation", async () => {
    installFakeLinearis(tmp, { payload: { nodes: [{ identifier: "CTL-1" }], pageInfo: { hasNextPage: false } } });
    const { code, out } = await runMain(["list", "--team", "CTL"]);
    expect(code).toBe(0);
    expect(out._meta.source).toBe("linearis");
    expect(out._meta.list_replica).toBe("pending");
    expect(out.nodes).toEqual([{ identifier: "CTL-1" }]);
  });
  test("search → linearis passthrough with _meta annotation", async () => {
    installFakeLinearis(tmp, { payload: { nodes: [{ identifier: "CTL-2" }] } });
    const { code, out } = await runMain(["search", "auth bug", "--team", "CTL"]);
    expect(code).toBe(0);
    expect(out._meta.source).toBe("linearis");
    expect(out._meta.search_replica).toBe("pending");
  });
  test("search with no query → exit 2", async () => {
    expect((await runMain(["search"])).code).toBe(2);
  });
  test("read with no ID → exit 2", async () => {
    expect((await runMain(["read"])).code).toBe(2);
  });
  test("linearis failure → exit 1 with structured stderr envelope", async () => {
    installFakeLinearis(tmp, { payload: { error: "boom" }, exitCode: 1 });
    const { code, err } = await runMain(["read", "CTL-1"]);
    expect(code).toBe(1);
    const env = JSON.parse(err.trim().split("\n").pop());
    expect(env.error).toContain("linearis issues read CTL-1 failed");
    expect(env.status).toBe(1);
  });
});

// ── linearis timeout scoping (Codex P2: read capped, list/search uncapped) ───
describe("linearis timeout scoping", () => {
  test("read honors CATALYST_LINEARIS_TIMEOUT_MS — slow linearis → timeout, exit 1", async () => {
    process.env.CATALYST_LINEARIS_TIMEOUT_MS = "100";
    installSlowLinearis(tmp, 600); // 600ms > 100ms cap → SIGKILL
    const { code, err } = await runMain(["read", "CTL-SLOW"]);
    expect(code).toBe(1);
    expect(JSON.parse(err.trim().split("\n").pop()).timedOut).toBe(true);
  });
  test("list is UNCAPPED — slow linearis completes despite a tiny read cap", async () => {
    process.env.CATALYST_LINEARIS_TIMEOUT_MS = "100";
    installSlowLinearis(tmp, 400); // would be killed at 100ms IF the cap applied
    const { code, out } = await runMain(["list"]);
    expect(code).toBe(0);
    expect(out._meta.source).toBe("linearis");
  });
  test("search is UNCAPPED — slow linearis completes despite a tiny read cap", async () => {
    process.env.CATALYST_LINEARIS_TIMEOUT_MS = "100";
    installSlowLinearis(tmp, 400);
    const { code, out } = await runMain(["search", "auth bug"]);
    expect(code).toBe(0);
    expect(out._meta.source).toBe("linearis");
  });
});

// ── usage / unknown command ─────────────────────────────────────────────────
describe("usage", () => {
  test("no command → usage to stdout, exit 1", async () => {
    const { code, raw } = await runMain([]);
    expect(code).toBe(1);
    expect(raw).toContain("catalyst-linear");
  });
  test("unknown command → exit 2", async () => {
    const { code } = await runMain(["frobnicate"]);
    expect(code).toBe(2);
  });
});

// ── CTL-1403: reads-by-source emit (catalyst.linear.read) ───────────────────
// Proves the emit fires END-TO-END through main() on both success and failure,
// landing a canonical line in the hermetic event log (CATALYST_DIR/events/…).
import { readFileSync as _readFileSync, existsSync as _existsSync } from "node:fs";
function readLinearReadEvents() {
  const now = new Date();
  const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const path = join(process.env.CATALYST_DIR, "events", `${ym}.jsonl`);
  if (!_existsSync(path)) return [];
  return _readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.attributes?.["event.name"] === "catalyst.linear.read");
}

describe("CTL-1403 reads-by-source emit", () => {
  test("successful read → one catalyst.linear.read (result=ok) with the full contract", async () => {
    installFakeLinearis(tmp, { payload: { identifier: "CTL-1", state: { name: "Todo" } } });
    const { code } = await runMain(["read", "CTL-1"]);
    expect(code).toBe(0);
    const events = readLinearReadEvents();
    expect(events.length).toBe(1);
    const e = events[0];
    expect(e.attributes["event.name"]).toBe("catalyst.linear.read");
    expect(e.attributes["event.entity"]).toBe("linear");
    expect(e.attributes["event.action"]).toBe("read");
    expect(e.attributes["event.label"]).toBe("CTL-1"); // entity_id, never a metric label
    expect(e.attributes["linear.read.source"]).toBe("linearis"); // mode off → direct linearis
    expect(e.attributes["linear.read.result"]).toBe("ok");
    expect(e.attributes["linear.read.op"]).toBe("read");
    expect(e.severityText).toBe("INFO");
    expect(e.resource["service.name"]).toBe("catalyst.linear-read");
  });

  test("failed read (linearis exits non-zero) → catalyst.linear.read result=failed, WARN", async () => {
    installFakeLinearis(tmp, { payload: { error: "boom" }, exitCode: 1 });
    const { code } = await runMain(["read", "CTL-9"]);
    expect(code).toBe(1); // read itself failed
    const events = readLinearReadEvents();
    expect(events.length).toBe(1);
    expect(events[0].attributes["linear.read.result"]).toBe("failed");
    expect(events[0].attributes["event.label"]).toBe("CTL-9");
    expect(events[0].severityText).toBe("WARN");
    expect(events[0].severityNumber).toBe(13);
  });

  test("list read → catalyst.linear.read op=list, no event.label (no single entity)", async () => {
    installFakeLinearis(tmp, { payload: { nodes: [] } });
    const { code } = await runMain(["list", "--team", "CTL"]);
    expect(code).toBe(0);
    const events = readLinearReadEvents();
    expect(events.length).toBe(1);
    expect(events[0].attributes["linear.read.op"]).toBe("list");
    expect("event.label" in events[0].attributes).toBe(false);
    expect(events[0].attributes["linear.read.source"]).toBe("linearis");
  });

  // Codex P2: a consulted-replica MISS whose live fallback FAILS must report
  // source=linearis_miss (not a bare-linearis bypass) so the guarantee-violation
  // alert (source="linearis") isn't tripped by replica misses during an outage.
  test("replica-miss + failing fallback → source=linearis_miss, result=failed (not a false bypass)", async () => {
    const dbPath = join(tmp, "catalyst-replica.db");
    seedReplica(dbPath); // fresh replica, but we read an ABSENT id
    process.env.CATALYST_LINEAR_REPLICA = "on";
    process.env.CATALYST_REPLICA_DB = dbPath;
    installFakeLinearis(tmp, { payload: { error: "boom" }, exitCode: 1 }); // live fallback fails
    const { code } = await runMain(["read", "CTL-ABSENT"]);
    expect(code).toBe(1);
    const events = readLinearReadEvents();
    expect(events.length).toBe(1);
    expect(events[0].attributes["linear.read.source"]).toBe("linearis_miss");
    expect(events[0].attributes["linear.read.result"]).toBe("failed");
    expect(events[0].severityText).toBe("WARN");
  });
});
