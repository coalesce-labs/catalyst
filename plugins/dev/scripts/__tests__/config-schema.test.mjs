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
import { join } from "node:path";
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
    // CTL-1214 D7: reconcile is in the relocating set — it is in the committed
    // config, it is node-scoped (CATALYST_RECONCILE_MODE is documented as the
    // hardest per-node override), and it already had a two-layer reader.
    reconcile: { mode: "notify", intervalSeconds: 600 },
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
    // CTL-1214 D6: the blanket `orchestration` row is gone — it is now the four
    // subpaths that actually relocate, so a config carrying only a genuinely
    // Layer-1 orchestration stanza (codex, executor, …) is NOT flagged.
    for (const path of [
      "monitor.linear.teams",
      "monitor.github.repoColors",
      "orchestration.dispatchMode",
      "orchestration.executionCore",
      "orchestration.worktreeRefresh",
      "orchestration.reconcile",
      "feedback",
      "sweep",
    ]) {
      expect(r.deprecatedKeys).toContain(path);
    }
    expect(r.deprecatedKeys).not.toContain("orchestration");
  });

  // CTL-1214 D6 — the narrowing, asserted in both directions. Without the
  // negative cases a blanket row would still pass the positive one.
  test("D6: a genuinely Layer-1 orchestration stanza is not a leak", () => {
    for (const stanza of [
      { codex: { codexHome: "/x/codex-home" } },
      { executor: "sdk" },
      { executorByPhase: { implement: "sdk" } },
      { fleetHealth: { mode: "shadow" } },
      { daemonWatchdog: { mode: "shadow" } },
      { publishPreflight: { mode: "shadow" } },
      { draftPr: { enabled: true } },
      { orphanReaper: { workerGc: { emptyDirGraceSeconds: 600 } } },
    ]) {
      const cfg = minimalLayer1();
      cfg.catalyst.orchestration = stanza;
      const r = validateLayer1Config(cfg);
      expect(r.deprecatedKeys).toEqual([]);
      expect(r.valid).toBe(true);
    }
  });

  test("D6: each relocating orchestration subpath IS a leak, on its own", () => {
    for (const [key, value] of [
      ["dispatchMode", "phase-agents"],
      ["executionCore", { maxParallel: 4 }],
      ["worktreeRefresh", { enabled: true }],
      ["reconcile", { mode: "notify" }],
    ]) {
      const cfg = minimalLayer1();
      cfg.catalyst.orchestration = { [key]: value };
      const r = validateLayer1Config(cfg);
      expect(r.deprecatedKeys).toEqual([`orchestration.${key}`]);
    }
  });

  test("D6: a mixed stanza flags only the relocating half", () => {
    const cfg = minimalLayer1();
    cfg.catalyst.orchestration = {
      codex: { codexHome: "/x" },
      executor: "sdk",
      dispatchMode: "phase-agents",
    };
    expect(validateLayer1Config(cfg).deprecatedKeys).toEqual(["orchestration.dispatchMode"]);
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

  test("RELOCATED_LAYER1_KEYS enumerates the leak categories (D6-narrowed)", () => {
    const paths = RELOCATED_LAYER1_KEYS.map((e) => e.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        "monitor.linear.teams",
        "monitor.github.repoColors",
        "orchestration.dispatchMode",
        "orchestration.executionCore",
        "orchestration.worktreeRefresh",
        "orchestration.reconcile",
        "feedback",
        "sweep",
      ]),
    );
    // D6: FOUR orchestration rows, never one blanket row.
    expect(paths.filter((p) => p.startsWith("orchestration"))).toHaveLength(4);
    expect(paths).not.toContain("orchestration");
    // D1: every node-scoped destination names node.json, matching where the
    // migration actually writes. A destination string that named the legacy
    // config.json would send an operator to a file the migration never touches.
    for (const entry of RELOCATED_LAYER1_KEYS) {
      if (entry.scope === "node") expect(entry.destination).toContain("node.json");
    }
    // every entry names a scope + destination so the doctor check can format remediation
    for (const entry of RELOCATED_LAYER1_KEYS) {
      expect(["cluster", "node"]).toContain(entry.scope);
      expect(typeof entry.destination).toBe("string");
      expect(entry.destination.length).toBeGreaterThan(0);
    }
  });
});

// CTL-1214 Phase 3 — the AC's "template is sanitized" scenario, asserted against
// the SHIPPED file on disk rather than a fixture. The template is what every new
// repo starts from, so a relocated stanza here re-leaks into every future config
// no matter how well the migration works.
describe("config.template.json is sanitized (CTL-1214)", () => {
  const templatePath = join(import.meta.dir, "..", "..", "templates", "config.template.json");
  const template = JSON.parse(readFileSync(templatePath, "utf8"));

  test("validates clean under validateLayer1Config", () => {
    const r = validateLayer1Config(template);
    expect(r.deprecatedKeys).toEqual([]);
    expect(r.errors).toEqual([]);
    expect(r.recommendations).toEqual([]);
    expect(r.valid).toBe(true);
  });

  test("carries schemaVersion 1", () => {
    expect(template.catalyst.schemaVersion).toBe(1);
  });

  test("ships no relocated stanza", () => {
    expect(template.catalyst.orchestration).toBeUndefined();
    expect(template.catalyst.feedback).toBeUndefined();
    expect(template.catalyst.sweep).toBeUndefined();
    expect(template.catalyst.monitor?.github?.repoColors).toBeUndefined();
  });

  test("keeps ticketPrefix PROJ, no teamId, no roster (the AC's template scenario)", () => {
    expect(template.catalyst.project.ticketPrefix).toBe("PROJ");
    expect("teamId" in template.catalyst.linear).toBe(false);
    expect(template.catalyst.monitor?.linear?.teams).toBeUndefined();
  });

  test("keeps the genuinely Layer-1 blocks (a template that over-slims is as bad)", () => {
    expect(template.catalyst.projectKey).toBeDefined();
    expect(template.catalyst.linear.teamKey).toBe("PROJ");
    expect(Object.keys(template.catalyst.linear.stateMap)).toHaveLength(12);
    expect(template.catalyst.deployment.mode).toBe("single-host");
    expect(template.catalyst.repository).toBeDefined();
    expect(template.catalyst.deploy).toBeDefined();
    expect(template.catalyst.filter).toBeDefined();
    expect("botUserId" in template.catalyst.monitor.linear).toBe(true);
    expect(template.catalyst.thoughts).toBeDefined();
  });
});

// CTL-1214 Phase 4 — THIS repo's committed .catalyst/config.json, read from disk.
// The regression guard cuts both ways: a migration that OVER-slims is as bad as
// one that under-slims, and losing stateMap would break every phase transition in
// the pipeline.
describe("this repo's committed .catalyst/config.json is slimmed (CTL-1214)", () => {
  const layer1Path = join(import.meta.dir, "..", "..", "..", "..", ".catalyst", "config.json");
  const cfg = JSON.parse(readFileSync(layer1Path, "utf8"));

  test("validates with no hard errors and schemaVersion 1", () => {
    const r = validateLayer1Config(cfg);
    expect(r.errors).toEqual([]);
    expect(r.valid).toBe(true);
    expect(cfg.catalyst.schemaVersion).toBe(1);
    expect(r.recommendations).toEqual([]);
  });

  test("the only remaining leak is the roster, which CTL-1885 owns (D4)", () => {
    expect(validateLayer1Config(cfg).deprecatedKeys).toEqual(["monitor.linear.teams"]);
  });

  test("carries no orchestration / feedback / sweep / repoColors", () => {
    expect(cfg.catalyst.orchestration).toBeUndefined();
    expect(cfg.catalyst.feedback).toBeUndefined();
    expect(cfg.catalyst.sweep).toBeUndefined();
    expect(cfg.catalyst.monitor?.github).toBeUndefined();
    // The dead key is gone entirely, not relocated.
    expect(JSON.stringify(cfg)).not.toContain("eligibleQuery");
  });

  test("the identity block is INTACT (the over-slim guard)", () => {
    expect(cfg.catalyst.projectKey).toBe("catalyst-workspace");
    expect(cfg.catalyst.project.ticketPrefix).toBe("CTL");
    expect(cfg.catalyst.linear.teamKey).toBe("CTL");
    expect(typeof cfg.catalyst.linear.teamId).toBe("string");
    expect(cfg.catalyst.linear.teamId.length).toBeGreaterThan(0);
    // All 12 states — losing stateMap breaks every phase transition.
    expect(Object.keys(cfg.catalyst.linear.stateMap)).toHaveLength(12);
    for (const k of [
      "backlog", "todo", "triage", "research", "planning", "inProgress",
      "verifying", "reviewing", "remediating", "inReview", "done", "canceled",
    ]) {
      expect(typeof cfg.catalyst.linear.stateMap[k]).toBe("string");
    }
    expect(cfg.catalyst.thoughts.org).toBe("coalesce-labs");
    expect(cfg.catalyst.thoughts.directory).toBe("catalyst-workspace");
    expect(cfg.catalyst.deployment.mode).toBe("cluster");
    // The roster stays (CTL-1885) and still names this repo — resolveRepoFullName
    // falls through to monitor.linear.teams[].vcsRepo once feedback.githubRepo is
    // gone from Layer-1, so an empty roster here would break the plugin-refresh
    // merge-event matcher.
    expect(cfg.catalyst.monitor.linear.teams.length).toBeGreaterThan(0);
    expect(cfg.catalyst.monitor.linear.teams[0].vcsRepo).toBe("coalesce-labs/catalyst");
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
