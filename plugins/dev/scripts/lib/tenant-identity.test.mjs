// tenant-identity.test.mjs — CTL-2299.
//
// Two halves, and the second is the one the ticket is actually about.
//
//   1. The resolver is a pure function over (env, two config paths), so every ladder rung
//      is a table row — including the NAMED-FAILURE rung, which is the whole point: an
//      unconfigured tenant must get a loud refusal, never a person-shaped guess.
//
//   2. A CORPUS SCAN over the shipped skill text and the non-test scripts, asserting the
//      fleet owner's Linear user id and the `Needs from <that person>` heading appear
//      nowhere. This is the ticket's own acceptance sentence ("no Ryan-specific value
//      remains in any skill text or default") turned into a guard — a rule stated in a
//      review comment is a rule that comes back.
//
//      ⛔ AGENTS.md's positive-control rule binds this scan: a corpus walk that silently
//      enumerated zero files would report a clean sweep for a repo full of violations.
//      So the scan is asserted to have READ a known-populated corpus (a floor on the file
//      count, and a control string that IS present), and the matcher itself is run against
//      a planted literal to prove it can return non-zero at all.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  HUMAN_CONFIG_PATH,
  UNNAMED_HUMAN,
  resolveAskHuman,
  resolveAskTeam,
  statusDocHumanHeading,
} from "./tenant-identity.mjs";

// The literal this ticket exists to remove. Written here — in a TEST, where a specific id
// is a fixture rather than a default — so the scan below has something concrete to hunt.
const FLEET_OWNER_ID = "c2a8cc92-cab6-4536-9500-0f24abdf702b";

// `import.meta.url`, not a cwd-relative path: `bun test` is run from several
// working-directories in CI, and a cwd-derived root would silently walk nothing.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

function writeConfig(dir, relPath, obj) {
  const full = join(dir, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, JSON.stringify(obj));
  return full;
}

function fixtureDir() {
  return mkdtempSync(join(tmpdir(), "ctl2299-"));
}

// A layer path that certainly does not exist, so a rung under test cannot be satisfied by
// whatever config happens to sit in the runner's cwd or home.
const ABSENT = "/nonexistent/ctl-2299/config.json";

describe("resolveAskHuman — the ladder", () => {
  test("env.ASK_HUMAN_ID wins", () => {
    const r = resolveAskHuman({
      env: { ASK_HUMAN_ID: "env-user" },
      layer1ConfigPath: ABSENT,
      layer2ConfigPath: ABSENT,
    });
    expect(r.ok).toBe(true);
    expect(r.humanId).toBe("env-user");
    expect(r.source).toBe("env");
  });

  test("layer 1 (.catalyst/config.json) supplies the human when env is unset", () => {
    const dir = fixtureDir();
    const l1 = writeConfig(dir, "repo/.catalyst/config.json", {
      catalyst: { human: { linearUserId: "tenant-human", name: "Dana" } },
    });
    const r = resolveAskHuman({ env: {}, layer1ConfigPath: l1, layer2ConfigPath: ABSENT });
    expect(r.ok).toBe(true);
    expect(r.humanId).toBe("tenant-human");
    expect(r.name).toBe("Dana");
    expect(r.source).toBe("layer1");
  });

  test("layer 2 (~/.config/catalyst/config.json) backstops a checkout that carries no human", () => {
    const dir = fixtureDir();
    const l1 = writeConfig(dir, "repo/.catalyst/config.json", { catalyst: { projectKey: "p" } });
    const l2 = writeConfig(dir, "home/.config/catalyst/config.json", {
      catalyst: { human: { linearUserId: "machine-human" } },
    });
    const r = resolveAskHuman({ env: {}, layer1ConfigPath: l1, layer2ConfigPath: l2 });
    expect(r.ok).toBe(true);
    expect(r.humanId).toBe("machine-human");
    expect(r.source).toBe("layer2");
  });

  test("an UNCONFIGURED tenant is a named failure, never a person", () => {
    const r = resolveAskHuman({ env: {}, layer1ConfigPath: ABSENT, layer2ConfigPath: ABSENT });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("human-not-configured");
    expect(r.message).toContain(HUMAN_CONFIG_PATH);
    // The regression this ticket is named for: the failure must NOT be the fleet owner.
    expect(JSON.stringify(r)).not.toContain(FLEET_OWNER_ID);
  });

  test("an empty ASK_HUMAN_ID is not a declaration — it falls through, it does not blank the id", () => {
    const dir = fixtureDir();
    const l1 = writeConfig(dir, "repo/.catalyst/config.json", {
      catalyst: { human: { linearUserId: "tenant-human" } },
    });
    const r = resolveAskHuman({
      env: { ASK_HUMAN_ID: "   " },
      layer1ConfigPath: l1,
      layer2ConfigPath: ABSENT,
    });
    expect(r.ok).toBe(true);
    expect(r.humanId).toBe("tenant-human");
  });

  test("Layer 1 is found by walking UP from cwd — an agent tool runs from a subdirectory", () => {
    const dir = fixtureDir();
    writeConfig(dir, "repo/.catalyst/config.json", {
      catalyst: { human: { linearUserId: "tenant-human" } },
    });
    const deep = join(dir, "repo/plugins/dev/scripts/__tests__");
    mkdirSync(deep, { recursive: true });
    const saved = process.cwd();
    try {
      process.chdir(deep);
      const r = resolveAskHuman({ env: {}, layer2ConfigPath: ABSENT });
      expect(r.ok).toBe(true);
      expect(r.humanId).toBe("tenant-human");
      expect(r.source).toBe("layer1");
    } finally {
      process.chdir(saved);
    }
  });

  test("a malformed config is 'nothing at this layer', not a throw", () => {
    const dir = fixtureDir();
    const full = join(dir, "broken.json");
    writeFileSync(full, "{ not json");
    const r = resolveAskHuman({ env: {}, layer1ConfigPath: full, layer2ConfigPath: ABSENT });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("human-not-configured");
  });
});

describe("resolveAskTeam — the ladder", () => {
  test("an explicit --team wins: a decision may belong to another team", () => {
    const r = resolveAskTeam({ team: "OPS", env: { ASK_TEAM: "ENV" }, layer1ConfigPath: ABSENT });
    expect(r.ok).toBe(true);
    expect(r.team).toBe("OPS");
    expect(r.source).toBe("explicit");
  });

  test("the tenant's own teamKey is the default", () => {
    const dir = fixtureDir();
    const l1 = writeConfig(dir, "repo/.catalyst/config.json", {
      catalyst: { linear: { teamKey: "TEN" } },
    });
    const r = resolveAskTeam({ env: {}, layer1ConfigPath: l1 });
    expect(r.ok).toBe(true);
    expect(r.team).toBe("TEN");
    expect(r.source).toBe("layer1");
  });

  test("no team anywhere is a named failure, not a fallback to CTL", () => {
    const r = resolveAskTeam({ env: {}, layer1ConfigPath: ABSENT });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("team-not-configured");
    expect(JSON.stringify(r)).not.toContain("CTL");
  });
});

describe("statusDocHumanHeading", () => {
  test("names the tenant's human", () => {
    expect(statusDocHumanHeading({ name: "Dana" })).toBe("## Needs from Dana");
  });

  test("an unnamed human reads as deliberate, not as a placeholder", () => {
    expect(statusDocHumanHeading({})).toBe(`## Needs from ${UNNAMED_HUMAN}`);
    expect(statusDocHumanHeading(undefined)).toBe(`## Needs from ${UNNAMED_HUMAN}`);
  });

  test("takes the resolver's result straight through", () => {
    const dir = fixtureDir();
    const l1 = writeConfig(dir, "repo/.catalyst/config.json", {
      catalyst: { human: { linearUserId: "u", name: "Dana" } },
    });
    const human = resolveAskHuman({ env: {}, layer1ConfigPath: l1, layer2ConfigPath: ABSENT });
    expect(statusDocHumanHeading(human)).toBe("## Needs from Dana");
  });
});

// ── the corpus scan ────────────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git", "__tests__", "coverage"]);

function walk(dir, keep, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(full, keep, out);
      continue;
    }
    let isFile = e.isFile();
    if (!isFile && e.isSymbolicLink()) {
      try {
        isFile = statSync(full).isFile();
      } catch {
        continue;
      }
    }
    if (isFile && keep(e.name)) out.push(full);
  }
  return out;
}

/** The shipped surface: skill text plus the non-test scripts that carry defaults. */
function shippedFiles() {
  const skills = walk(join(REPO_ROOT, "plugins/dev/skills"), (n) => n.endsWith(".md"));
  const scripts = walk(
    join(REPO_ROOT, "plugins/dev/scripts"),
    (n) => n.endsWith(".mjs") && !n.endsWith(".test.mjs"),
  );
  return [...skills, ...scripts];
}

function filesContaining(files, needle) {
  const hits = [];
  for (const f of files) {
    try {
      if (readFileSync(f, "utf8").includes(needle)) hits.push(f.slice(REPO_ROOT.length + 1));
    } catch {
      /* unreadable file — not evidence either way */
    }
  }
  return hits;
}

describe("no fleet-owner literal survives in the shipped surface (CTL-2299 Tier 1)", () => {
  const files = shippedFiles();

  test("POSITIVE CONTROL: the scan actually read a populated corpus", () => {
    // A silent zero-file walk would make every assertion below pass vacuously.
    expect(files.length).toBeGreaterThan(50);
    // …and the matcher can return non-zero: `catalyst-ask` is present by construction.
    expect(filesContaining(files, "catalyst-ask").length).toBeGreaterThan(0);
    // …and it finds a planted literal in a file of exactly the scanned shape.
    const dir = fixtureDir();
    const planted = join(dir, "planted.md");
    writeFileSync(planted, `assignee ${FLEET_OWNER_ID}\n`);
    expect(filesContaining([planted], FLEET_OWNER_ID).length).toBe(1);
  });

  test("the fleet owner's Linear user id appears in no skill text and no shipped default", () => {
    expect(filesContaining(files, FLEET_OWNER_ID)).toEqual([]);
  });

  test("the status-doc template heading is not named for one person", () => {
    expect(filesContaining(files, "Needs from Ryan")).toEqual([]);
  });
});
