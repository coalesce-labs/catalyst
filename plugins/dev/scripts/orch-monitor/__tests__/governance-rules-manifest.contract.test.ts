// governance-rules-manifest.contract.test.ts — CTL-1100 Phase 7
// Contract: GET /api/beliefs/rules body deep-equals RULE_MANIFEST from
// rules.mjs. Recompiling the rules without re-exporting must turn this red.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer } from "../server";

// Contract: import the exact same module the endpoint serves from.
// Computed specifier: rules.mjs transitively imports bun:sqlite via schema.mjs.
// @ts-expect-error — execution-core mjs module has no .d.mts; runtime types are correct
const rulesMod = await import("../../execution-core/beliefs/rules.mjs");
const { RULE_MANIFEST } = rulesMod as {
  RULE_MANIFEST: {
    strata: Array<{ stratum: number; name: string }>;
    rules: Array<{ rule_id: string; name: string; sql?: string }>;
  };
};

function jsonNorm<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

let server: ReturnType<typeof createServer>;
let baseUrl: string;
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "gov-rules-contract-"));
  server = createServer({ port: 0, startWatcher: false, dbPath: join(tmpDir, "catalyst.db"), wtDir: tmpDir, annotationsDbPath: join(tmpDir, "annotations.db") });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  void server?.stop(true);
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ─── helpers ────────────────────────────────────────────────────────────────

async function fetchRules(): Promise<Record<string, unknown>> {
  const res = await fetch(`${baseUrl}/api/beliefs/rules`);
  expect(res.status).toBe(200);
  return res.json() as Promise<Record<string, unknown>>;
}

// ─── 1. Full deep-equal against live RULE_MANIFEST ──────────────────────────

describe("GET /api/beliefs/rules — full contract", () => {
  it("body deep-equals JSON.parse(JSON.stringify(RULE_MANIFEST))", async () => {
    const body = await fetchRules();
    expect(body).toEqual(jsonNorm(RULE_MANIFEST));
  });
});

// ─── 2. Anti-stub guards (derived counts, not hardcoded) ────────────────────

describe("GET /api/beliefs/rules — anti-stub guards", () => {
  it("body.rules.length === RULE_MANIFEST.rules.length (not hardcoded)", async () => {
    const body = await fetchRules() as { rules: unknown[] };
    // This must be derived from the live import, NOT hardcoded.
    expect(body.rules.length).toBe(RULE_MANIFEST.rules.length);
  });

  it("body.strata.length matches RULE_MANIFEST.strata.length", async () => {
    const body = await fetchRules() as { strata: unknown[] };
    expect(body.strata.length).toBe(RULE_MANIFEST.strata.length);
  });

  it("first rule has rule_id 'R1'", async () => {
    const body = await fetchRules() as { rules: Array<{ rule_id: string }> };
    expect(body.rules[0]?.rule_id).toBe("R1");
  });

  it("body.rules key set matches RULE_MANIFEST rule key set", async () => {
    const body = await fetchRules() as { rules: Array<Record<string, unknown>> };
    const bodyIds = new Set(body.rules.map((r) => r.rule_id));
    const manifestIds = new Set(RULE_MANIFEST.rules.map((r) => r.rule_id));
    expect(bodyIds).toEqual(manifestIds);
  });

  it("at least one rule arm carries a sql string", async () => {
    const body = await fetchRules() as { rules: Array<{ arms: Array<{ sql?: string }> }> };
    // sql lives under each rule's arms[], not directly on the rule object.
    const hasSql = body.rules.some((r) =>
      Array.isArray(r.arms) && r.arms.some((a) => typeof a.sql === "string" && a.sql.length > 0)
    );
    expect(hasSql).toBe(true);
  });
});

// ─── 3. Rulebook copy fields (CTL-1103) ─────────────────────────────────────

describe("GET /api/beliefs/rules — Rulebook copy fields (CTL-1103)", () => {
  it("every rule has a non-empty plain-English description", async () => {
    const body = await fetchRules() as { rules: Array<{ rule_id: string; description?: string }> };
    for (const r of body.rules) {
      expect(typeof r.description, `${r.rule_id} description must be a string`).toBe("string");
      expect(r.description!.length, `${r.rule_id} description must be non-empty`).toBeGreaterThan(0);
    }
  });

  it("manifest carries a top-level preface with problem and datalog_primer", async () => {
    const body = await fetchRules() as { preface?: { problem?: string; datalog_primer?: string } };
    expect(body.preface).toBeDefined();
    expect(typeof body.preface!.problem).toBe("string");
    expect(body.preface!.problem!.length).toBeGreaterThan(0);
    expect(typeof body.preface!.datalog_primer).toBe("string");
    expect(body.preface!.datalog_primer!.length).toBeGreaterThan(0);
  });
});

// ─── 4. CTL-1327: parameterized head + real .dl Datalog ─────────────────────

describe("GET /api/beliefs/rules — head atom + real Datalog (CTL-1327)", () => {
  it("every rule has a head with a string subject and an array of value_keys", async () => {
    const body = await fetchRules() as {
      rules: Array<{ rule_id: string; head?: { subject?: unknown; value_keys?: unknown } }>;
    };
    for (const r of body.rules) {
      expect(r.head, `${r.rule_id} must have a head`).toBeDefined();
      expect(typeof r.head!.subject, `${r.rule_id} head.subject`).toBe("string");
      expect(Array.isArray(r.head!.value_keys), `${r.rule_id} head.value_keys`).toBe(true);
    }
  });

  it("compiled (non-extern) rules expose the real .dl clause (a `:-` body), not compiled SQL", async () => {
    const body = await fetchRules() as {
      rules: Array<{ rule_id: string; extern: boolean; arms: Array<{ datalog: string | null }> }>;
    };
    const compiled = body.rules.filter((r) => !r.extern);
    expect(compiled.length).toBeGreaterThan(0);
    for (const r of compiled) {
      const dl = r.arms[0]?.datalog ?? "";
      expect(dl, `${r.rule_id} datalog must be the .dl clause`).toContain(":-");
      expect(dl, `${r.rule_id} datalog must NOT be the compiled SQL`).not.toContain(
        "INSERT OR IGNORE INTO belief",
      );
    }
  });

  it("extern rules carry null datalog (no Datalog clause)", async () => {
    const body = await fetchRules() as {
      rules: Array<{ rule_id: string; extern: boolean; arms: Array<{ datalog: string | null }> }>;
    };
    for (const r of body.rules.filter((x) => x.extern)) {
      expect(r.arms[0]?.datalog, `${r.rule_id} extern datalog should be null`).toBeNull();
    }
  });
});
