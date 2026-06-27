// config-schema.test.mjs — CTL-1214 Phase 1: schema foundation + schemaVersion.
//
// Run: cd plugins/dev/scripts && bun test __tests__/config-schema.test.mjs
//
// Covers three scopes:
//   - Layer-1 repo config (docs/schemas/catalyst-config.schema.json) via the pure
//     validateLayer1Config() helper (schemaVersion + scope-leak detection);
//   - Layer-2 node config (docs/schemas/machine-config.schema.json) accepts every
//     relocated key;
//   - cluster config (docs/schemas/cluster.schema.json) accepts projects[].
//
// There is no ajv resolvable from plugins/dev/scripts, so this file carries a
// small draft-07 subset validator (validateAgainstSchema) sufficient for the
// type/required/enum/minimum/properties/additionalProperties/items constructs the
// three schemas actually use.

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  validateLayer1Config,
  RELOCATED_LAYER1_KEYS,
} from "../lib/validate-catalyst-config.mjs";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const loadSchema = (name) =>
  JSON.parse(readFileSync(`${repoRoot}docs/schemas/${name}`, "utf8"));

const catalystConfigSchema = loadSchema("catalyst-config.schema.json");
const machineConfigSchema = loadSchema("machine-config.schema.json");
const clusterSchema = loadSchema("cluster.schema.json");

// --- minimal draft-07 subset validator -------------------------------------

function typeMatches(value, type) {
  switch (type) {
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return true;
  }
}

function validateAgainstSchema(value, schema, path = "$", errors = []) {
  if (schema == null || typeof schema !== "object") return errors;

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(value, t))) {
      const got = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
      errors.push(`${path}: expected type ${types.join("|")}, got ${got}`);
      return errors; // type mismatch — deeper checks are meaningless
    }
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((e) => e === value)) {
    errors.push(`${path}: value ${JSON.stringify(value)} not in enum ${JSON.stringify(schema.enum)}`);
  }

  if (typeof schema.minimum === "number" && typeof value === "number" && value < schema.minimum) {
    errors.push(`${path}: ${value} < minimum ${schema.minimum}`);
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const props = schema.properties || {};
    if (Array.isArray(schema.required)) {
      for (const req of schema.required) {
        if (!(req in value)) errors.push(`${path}: missing required property '${req}'`);
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (key in props) {
        validateAgainstSchema(child, props[key], `${path}.${key}`, errors);
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}: additional property '${key}' not allowed`);
      } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        validateAgainstSchema(child, schema.additionalProperties, `${path}.${key}`, errors);
      }
    }
  }

  if (Array.isArray(value) && schema.items && typeof schema.items === "object") {
    value.forEach((el, i) => validateAgainstSchema(el, schema.items, `${path}[${i}]`, errors));
  }

  return errors;
}

// Sanity-check the validator itself so the schema tests below are trustworthy.
describe("validateAgainstSchema (test harness self-check)", () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["a"],
    properties: { a: { type: "integer", minimum: 1 } },
  };
  test("accepts a conforming object", () => {
    expect(validateAgainstSchema({ a: 2 }, schema)).toEqual([]);
  });
  test("rejects an unknown key under additionalProperties:false", () => {
    expect(validateAgainstSchema({ a: 2, b: 3 }, schema).length).toBeGreaterThan(0);
  });
  test("rejects a missing required key", () => {
    expect(validateAgainstSchema({}, schema).length).toBeGreaterThan(0);
  });
  test("rejects a value below minimum", () => {
    expect(validateAgainstSchema({ a: 0 }, schema).length).toBeGreaterThan(0);
  });
});

// --- Layer-1 (catalyst-config.schema.json) ---------------------------------

const minimalLayer1 = () => ({
  catalyst: {
    schemaVersion: 1,
    projectKey: "catalyst-workspace",
    project: { ticketPrefix: "CTL" },
    linear: {
      teamKey: "CTL",
      teamId: "e7e703c4-13a8-42d4-97c1-25e342618f25",
      stateMap: { todo: "Todo", done: "Done" },
    },
    thoughts: { profile: "coalesce-labs", directory: "catalyst-workspace", user: null },
  },
});

const kitchenSinkLayer1 = () => {
  const cfg = minimalLayer1();
  cfg.catalyst.monitor = {
    github: { repoColors: { "coalesce-labs/catalyst": "green" } },
    linear: { teams: [{ key: "CTL", vcsRepo: "coalesce-labs/catalyst" }] },
  };
  cfg.catalyst.orchestration = {
    dispatchMode: "phase-agents",
    worktreeRefresh: { enabled: true, intervalSeconds: 300, quietSeconds: 30 },
    executionCore: {
      maxParallel: 4,
      minParallel: 1,
      maxParallelCeiling: 40,
      eligibleQuery: { status: "Todo", team: null, project: null, label: null, priority: null },
    },
  };
  cfg.catalyst.feedback = { autoFile: true, githubRepo: "coalesce-labs/catalyst", labels: ["auto-submitted"] };
  cfg.catalyst.sweep = { idleHours: 48, intervalHours: 1, salvagePush: false, maxRemovalsPerRun: 10 };
  return cfg;
};

describe("validateLayer1Config (CTL-1214)", () => {
  test("minimal identity config validates with no deprecated keys", () => {
    const r = validateLayer1Config(minimalLayer1());
    expect(r.valid).toBe(true);
    expect(r.deprecatedKeys).toEqual([]);
    expect(r.errors).toEqual([]);
  });

  test("legacy keys validate but are flagged deprecated (back-compat window)", () => {
    const r = validateLayer1Config(kitchenSinkLayer1());
    expect(r.valid).toBe(true); // still valid during migration
    expect(r.deprecatedKeys.length).toBeGreaterThan(0);
    for (const path of [
      "monitor.linear.teams",
      "monitor.github.repoColors",
      "orchestration",
      "feedback",
      "sweep",
    ]) {
      expect(r.deprecatedKeys).toContain(path);
    }
  });

  test("monitor.linear.botUserId is NOT treated as a leak", () => {
    const cfg = minimalLayer1();
    cfg.catalyst.monitor = {
      suppressVersionWarning: true,
      linear: { botUserId: "00000000-0000-0000-0000-000000000000" },
    };
    const r = validateLayer1Config(cfg);
    expect(r.deprecatedKeys).toEqual([]);
    expect(r.valid).toBe(true);
  });

  test("schemaVersion is recommended (back-compat) but a PRESENT value must be >= 1", () => {
    // Back-compat window (CTL-1214 P2 #2): a config WITHOUT schemaVersion still
    // validates — every not-yet-slimmed config lacks it (Phase 6 deferred) — and is
    // surfaced as a recommendation, not a failure.
    const missing = minimalLayer1();
    delete missing.catalyst.schemaVersion;
    const missingResult = validateLayer1Config(missing);
    expect(missingResult.valid).toBe(true);
    expect(missingResult.errors).toEqual([]);
    expect(missingResult.recommendations.length).toBeGreaterThan(0);
    expect(missingResult.recommendations.join(" ")).toContain("schemaVersion");

    // A PRESENT-but-malformed value is still a hard error (set it correctly).
    const zero = minimalLayer1();
    zero.catalyst.schemaVersion = 0;
    expect(validateLayer1Config(zero).valid).toBe(false);

    const nonInt = minimalLayer1();
    nonInt.catalyst.schemaVersion = 1.5;
    expect(validateLayer1Config(nonInt).valid).toBe(false);

    // A present, well-formed version validates with no recommendation.
    const ok = validateLayer1Config(minimalLayer1());
    expect(ok.valid).toBe(true);
    expect(ok.recommendations).toEqual([]);
  });

  test("teamId may be null (template) without affecting validity", () => {
    const cfg = minimalLayer1();
    cfg.catalyst.linear.teamId = null;
    const r = validateLayer1Config(cfg);
    expect(r.valid).toBe(true);
    expect(r.deprecatedKeys).toEqual([]);
  });

  test("missing top-level catalyst object is invalid", () => {
    expect(validateLayer1Config({}).valid).toBe(false);
    expect(validateLayer1Config(null).valid).toBe(false);
  });

  test("RELOCATED_LAYER1_KEYS enumerates the five leak categories", () => {
    const paths = RELOCATED_LAYER1_KEYS.map((e) => e.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        "monitor.linear.teams",
        "monitor.github.repoColors",
        "orchestration",
        "feedback",
        "sweep",
      ]),
    );
    // every entry names a scope + destination so the doctor check can format remediation
    for (const entry of RELOCATED_LAYER1_KEYS) {
      expect(["cluster", "node"]).toContain(entry.scope);
      expect(typeof entry.destination).toBe("string");
      expect(entry.destination.length).toBeGreaterThan(0);
    }
  });
});

describe("catalyst-config.schema.json (Layer-1 schema)", () => {
  test("minimal identity config conforms to the schema", () => {
    expect(validateAgainstSchema(minimalLayer1(), catalystConfigSchema)).toEqual([]);
  });

  test("schemaVersion is an integer property, recommended (NOT required) during back-compat", () => {
    // CTL-1214 P2 #2: it must NOT be in `required` during the back-compat window,
    // so editors/validators don't flag every not-yet-slimmed config as invalid.
    const catalystProps = catalystConfigSchema.properties.catalyst;
    expect(catalystProps.required ?? []).not.toContain("schemaVersion");
    expect(catalystProps.properties.schemaVersion.type).toBe("integer");
    expect(catalystProps.properties.schemaVersion.minimum).toBe(1);
  });

  test("a config WITHOUT schemaVersion still conforms to the schema (back-compat)", () => {
    const noVersion = minimalLayer1();
    delete noVersion.catalyst.schemaVersion;
    expect(validateAgainstSchema(noVersion, catalystConfigSchema)).toEqual([]);
  });

  test("the relocated stanzas are still permitted but annotated deprecated", () => {
    // back-compat: a kitchen-sink config still conforms during the migration window
    expect(validateAgainstSchema(kitchenSinkLayer1(), catalystConfigSchema)).toEqual([]);
    const cat = catalystConfigSchema.properties.catalyst.properties;
    expect(cat.orchestration.deprecated).toBe(true);
    expect(cat.feedback.deprecated).toBe(true);
    expect(cat.sweep.deprecated).toBe(true);
    expect(cat.monitor.properties.github.properties.repoColors.deprecated).toBe(true);
    expect(cat.monitor.properties.linear.properties.teams.deprecated).toBe(true);
    // botUserId remains a non-deprecated Layer-1 field
    expect(cat.monitor.properties.linear.properties.botUserId.deprecated).toBeUndefined();
  });
});

// --- Layer-2 (machine-config.schema.json) ----------------------------------

describe("machine-config.schema.json accepts the relocated keys (Layer-2 destinations)", () => {
  test("accepts orchestration.dispatchMode", () => {
    const cfg = { catalyst: { orchestration: { dispatchMode: "phase-agents" } } };
    expect(validateAgainstSchema(cfg, machineConfigSchema)).toEqual([]);
  });

  test("accepts orchestration.worktreeRefresh (the previously-missing shape)", () => {
    const cfg = {
      catalyst: {
        orchestration: { worktreeRefresh: { enabled: true, intervalSeconds: 300, quietSeconds: 30 } },
      },
    };
    expect(validateAgainstSchema(cfg, machineConfigSchema)).toEqual([]);
  });

  test("accepts executionCore concurrency fields incl. targetParallel", () => {
    const cfg = {
      catalyst: {
        orchestration: {
          executionCore: { maxParallel: 6, minParallel: 1, maxParallelCeiling: 40, targetParallel: 6 },
        },
      },
    };
    expect(validateAgainstSchema(cfg, machineConfigSchema)).toEqual([]);
  });

  test("accepts feedback.* and sweep.*", () => {
    const cfg = {
      catalyst: {
        feedback: { autoFile: true, githubRepo: "coalesce-labs/catalyst", labels: ["auto-submitted"] },
        sweep: { idleHours: 48, intervalHours: 2, salvagePush: false, maxRemovalsPerRun: 20 },
      },
    };
    expect(validateAgainstSchema(cfg, machineConfigSchema)).toEqual([]);
  });

  test("accepts monitor.github.repoColors", () => {
    const cfg = { catalyst: { monitor: { github: { repoColors: { "coalesce-labs/catalyst": "green" } } } } };
    expect(validateAgainstSchema(cfg, machineConfigSchema)).toEqual([]);
  });

  test("still rejects an unknown top-level key (additionalProperties:false intact)", () => {
    const cfg = { catalyst: { bogusKey: true } };
    expect(validateAgainstSchema(cfg, machineConfigSchema).length).toBeGreaterThan(0);
  });
});

// --- cluster (cluster.schema.json) -----------------------------------------

describe("cluster.schema.json accepts projects[]", () => {
  test("projects[] with {teamKey,vcsRepo,projectKey} validates", () => {
    const cfg = {
      schemaVersion: 1,
      roster: ["mini"],
      projects: [
        { teamKey: "CTL", vcsRepo: "coalesce-labs/catalyst", projectKey: "catalyst-workspace" },
        { teamKey: "ADV", vcsRepo: "groundworkapp/Adva", projectKey: "adva" },
      ],
    };
    expect(validateAgainstSchema(cfg, clusterSchema)).toEqual([]);
  });

  test("a project entry missing projectKey is rejected", () => {
    const cfg = {
      schemaVersion: 1,
      roster: ["mini"],
      projects: [{ teamKey: "CTL", vcsRepo: "coalesce-labs/catalyst" }],
    };
    expect(validateAgainstSchema(cfg, clusterSchema).length).toBeGreaterThan(0);
  });

  test("schemaVersion and roster are required", () => {
    expect(validateAgainstSchema({ roster: ["mini"] }, clusterSchema).length).toBeGreaterThan(0);
    expect(validateAgainstSchema({ schemaVersion: 1 }, clusterSchema).length).toBeGreaterThan(0);
  });
});
