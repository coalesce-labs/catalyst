// cloud-facts.test.mjs — CTL-2300.
//
// Two halves, and the second is the one that keeps this ticket fixed:
//
//   1. the resolver's own ladder and its retired-host refusal;
//   2. ⭐ THE DENY-LIST SCAN — no shipped skill text and no shipped script may carry the
//      literals this ticket deleted. A resolver that nobody calls fixes nothing, so the
//      scan is what stops the next agent re-adding `api.catalyst-cloud.coalescelabs.ai`
//      as a "sane default" three modules over.
//
// ⛔ AGENTS.md's positive-control rule binds the scan: a corpus walk that silently reads
// zero files passes every "this literal is absent" assertion vacuously, and reads exactly
// like a clean bill of health. So the scan asserts it READ a populated corpus, that its
// matcher can return non-zero on a string known to be present, and that it finds a planted
// literal in a file of exactly the scanned shape. Same three controls
// tenant-identity.test.mjs established for CTL-2299's scan.
//
// Run: `bun test cloud-facts.test.mjs` from plugins/dev/scripts/lib (or via run-tests.sh's
// `bun test ../lib/*.test.mjs`). Named explicitly in
// .github/workflows/execution-core-tests.yml so a `grep -n cloud-facts.test` there returns
// a hit — a suite discovered by nothing is a suite that never runs.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BASE_URL_CONFIG_PATH,
  CANONICAL_CLOUD_HOST,
  DEFAULT_CLOUD_BASE_URL,
  DEFAULT_HOST_DAILY_WRITE_BUDGET,
  RETIRED_CLOUD_HOST_SUFFIXES,
  WRITE_BUDGET_CONFIG_PATH,
  isRetiredCloudHost,
  resolveCloudBaseUrl,
  resolveHostDailyWriteBudget,
} from "./cloud-facts.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..", "..");

/** The exact retired host that shipped as a default in two modules until this ticket. */
const RETIRED_BASE_URL = "https://api.catalyst-cloud.coalescelabs.ai/api/v1";

/** A path that exists nowhere, for pinning a layer OFF in a resolver call. */
const ABSENT = join(tmpdir(), "catalyst-cloud-facts-absent", "config.json");

function fixtureDir() {
  return mkdtempSync(join(tmpdir(), "cloud-facts-"));
}

function writeConfig(dir, rel, body) {
  const full = join(dir, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, JSON.stringify(body));
  return full;
}

// ── the base-URL ladder ────────────────────────────────────────────────────────────────

describe("resolveCloudBaseUrl — env → layer1 → layer2 → canonical", () => {
  test("with nothing configured it resolves the CANONICAL host, not a retired one", () => {
    const r = resolveCloudBaseUrl({ env: {}, layer1ConfigPath: ABSENT, layer2ConfigPath: ABSENT });
    expect(r).toEqual({ ok: true, baseUrl: DEFAULT_CLOUD_BASE_URL, source: "default" });
    expect(r.baseUrl).toContain(CANONICAL_CLOUD_HOST);
  });

  test("env wins over both config layers", () => {
    const dir = fixtureDir();
    const l1 = writeConfig(dir, "repo/.catalyst/config.json", {
      catalyst: { cloud: { baseUrl: "https://layer1.example/api/v1" } },
    });
    const r = resolveCloudBaseUrl({
      env: { CATALYST_CLOUD_BASE_URL: "https://env.example/api/v1" },
      layer1ConfigPath: l1,
      layer2ConfigPath: ABSENT,
    });
    expect(r).toEqual({ ok: true, baseUrl: "https://env.example/api/v1", source: "env" });
  });

  test("layer 1 (the committed repo config) wins over layer 2 (the machine's)", () => {
    const dir = fixtureDir();
    const l1 = writeConfig(dir, "repo/.catalyst/config.json", {
      catalyst: { cloud: { baseUrl: "https://layer1.example/api/v1" } },
    });
    const l2 = writeConfig(dir, "home/.config/catalyst/config.json", {
      catalyst: { cloud: { baseUrl: "https://layer2.example/api/v1" } },
    });
    const r = resolveCloudBaseUrl({ env: {}, layer1ConfigPath: l1, layer2ConfigPath: l2 });
    expect(r).toEqual({ ok: true, baseUrl: "https://layer1.example/api/v1", source: "layer1" });
  });

  test("layer 2 answers when layer 1 is silent — a host-level tenant, not a repo-level one", () => {
    const dir = fixtureDir();
    const l2 = writeConfig(dir, "home/.config/catalyst/config.json", {
      catalyst: { cloud: { baseUrl: "https://layer2.example/api/v1" } },
    });
    const r = resolveCloudBaseUrl({ env: {}, layer1ConfigPath: ABSENT, layer2ConfigPath: l2 });
    expect(r.source).toBe("layer2");
  });

  test("an empty or whitespace value is NOT a declaration — it falls through", () => {
    const r = resolveCloudBaseUrl({
      env: { CATALYST_CLOUD_BASE_URL: "   " },
      layer1ConfigPath: ABSENT,
      layer2ConfigPath: ABSENT,
    });
    expect(r.source).toBe("default");
  });

  test("a malformed URL is a NAMED failure, not a silent fall-through to the default", () => {
    const r = resolveCloudBaseUrl({
      env: { CATALYST_CLOUD_BASE_URL: "not a url" },
      layer1ConfigPath: ABSENT,
      layer2ConfigPath: ABSENT,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("malformed-url");
    expect(r.message).toContain(DEFAULT_CLOUD_BASE_URL);
  });
});

describe("⛔ the retired estate is refused from EVERY rung", () => {
  for (const [source, call] of [
    ["env", () => ({ env: { CATALYST_CLOUD_BASE_URL: RETIRED_BASE_URL } })],
    [
      "layer1",
      () => {
        const dir = fixtureDir();
        return {
          env: {},
          layer1ConfigPath: writeConfig(dir, "repo/.catalyst/config.json", {
            catalyst: { cloud: { baseUrl: RETIRED_BASE_URL } },
          }),
        };
      },
    ],
    [
      "layer2",
      () => {
        const dir = fixtureDir();
        return {
          env: {},
          layer2ConfigPath: writeConfig(dir, "home/.config/catalyst/config.json", {
            catalyst: { cloud: { baseUrl: RETIRED_BASE_URL } },
          }),
        };
      },
    ],
  ]) {
    test(`a retired host declared at ${source} is a named failure, not a passthrough`, () => {
      const r = resolveCloudBaseUrl({
        layer1ConfigPath: ABSENT,
        layer2ConfigPath: ABSENT,
        ...call(),
      });
      expect(r.ok).toBe(false);
      expect(r.reason).toBe("retired-host");
      expect(r.source).toBe(source);
      // The message has to be actionable on its own — it is printed by a caller that has
      // already decided to continue.
      expect(r.message).toContain(CANONICAL_CLOUD_HOST);
      expect(r.message).toContain(BASE_URL_CONFIG_PATH);
    });
  }

  test("a SIBLING host on the same retired zone is refused too, not only the one we shipped", () => {
    const r = resolveCloudBaseUrl({
      env: { CATALYST_CLOUD_BASE_URL: "https://mirror.catalyst-cloud.coalescelabs.ai/api/v1" },
      layer1ConfigPath: ABSENT,
      layer2ConfigPath: ABSENT,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("retired-host");
  });

  test("⛔ CONTROL: the guard matches the HOSTNAME, not the string", () => {
    // A path or query that merely mentions the old host is not a retired host — a substring
    // test over the whole URL would make the guard unusable (this file's own prose would
    // trip it) and would refuse a perfectly good canonical URL.
    expect(
      isRetiredCloudHost(
        `https://${CANONICAL_CLOUD_HOST}/api/v1?from=api.catalyst-cloud.coalescelabs.ai`,
      ),
    ).toBe(false);
    expect(isRetiredCloudHost(RETIRED_BASE_URL)).toBe(true);
    // Not a URL at all is "not retired" — malformed is a different verdict.
    expect(isRetiredCloudHost("nonsense")).toBe(false);
  });
});

// ── the write budget ───────────────────────────────────────────────────────────────────

describe("resolveHostDailyWriteBudget — the mirror of the cloud's own cap", () => {
  test("⭐ the default is the cloud's 3000, not the 300 the host used to self-limit at", () => {
    // The whole wrong-today item: the cloud raised its cap in CTC-796 and the host copy
    // never followed, so a busy host announced exhaustion at a TENTH of its allowance.
    expect(DEFAULT_HOST_DAILY_WRITE_BUDGET).toBe(3000);
    expect(
      resolveHostDailyWriteBudget({ env: {}, layer1ConfigPath: ABSENT, layer2ConfigPath: ABSENT }),
    ).toEqual({ budget: 3000, source: "default" });
  });

  test("env and both config layers are honoured, in that order", () => {
    const dir = fixtureDir();
    const l1 = writeConfig(dir, "repo/.catalyst/config.json", {
      catalyst: { cloud: { hostDailyWriteBudget: 1500 } },
    });
    const l2 = writeConfig(dir, "home/.config/catalyst/config.json", {
      catalyst: { cloud: { hostDailyWriteBudget: 900 } },
    });
    expect(
      resolveHostDailyWriteBudget({
        env: { CATALYST_HOST_DAILY_WRITE_BUDGET: "42" },
        layer1ConfigPath: l1,
        layer2ConfigPath: l2,
      }).budget,
    ).toBe(42);
    expect(
      resolveHostDailyWriteBudget({ env: {}, layer1ConfigPath: l1, layer2ConfigPath: l2 }),
    ).toEqual({ budget: 1500, source: "layer1" });
    expect(
      resolveHostDailyWriteBudget({ env: {}, layer1ConfigPath: ABSENT, layer2ConfigPath: l2 }),
    ).toEqual({ budget: 900, source: "layer2" });
  });

  test("⛔ a typo cannot cause an outage: 0, negative and non-numeric fall THROUGH", () => {
    // A budget of 0 reads as "refuse every write". On a mirror of somebody else's number
    // that is an outage a fat finger should not be able to cause.
    for (const bad of ["0", "-5", "lots", "12.5", ""]) {
      expect(
        resolveHostDailyWriteBudget({
          env: { CATALYST_HOST_DAILY_WRITE_BUDGET: bad },
          layer1ConfigPath: ABSENT,
          layer2ConfigPath: ABSENT,
        }),
      ).toEqual({ budget: DEFAULT_HOST_DAILY_WRITE_BUDGET, source: "default" });
    }
  });
});

// ── the deny-list scan ─────────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git", "coverage"]);

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

/**
 * The SHIPPED surface: skill text plus the scripts and launchers that carry defaults.
 *
 * ⚠️ Tests and this file are excluded on purpose — a deny-list suite that cannot name the
 * literal it forbids cannot document why it forbids it. `lib/cloud-facts.mjs` is excluded
 * for the same reason: it is where the retired host is DECLARED retired.
 */
function shippedFiles() {
  const skills = walk(join(REPO_ROOT, "plugins/dev/skills"), (n) => n.endsWith(".md"));
  const scripts = walk(
    join(REPO_ROOT, "plugins/dev/scripts"),
    (n) => (n.endsWith(".mjs") || n.endsWith(".sh")) && !n.includes(".test."),
  ).filter((f) => !f.endsWith(join("lib", "cloud-facts.mjs")));
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

describe("no wrong-today cloud literal survives in the shipped surface (CTL-2300 Tier 2)", () => {
  const files = shippedFiles();

  test("POSITIVE CONTROL: the scan actually read a populated corpus", () => {
    // A silent zero-file walk would make every assertion below pass vacuously.
    expect(files.length).toBeGreaterThan(100);
    // …and the matcher returns non-zero on a string that is present by construction.
    expect(filesContaining(files, "check-project-setup").length).toBeGreaterThan(0);
    // …and it finds a planted literal in a file of exactly the scanned shape.
    const planted = join(fixtureDir(), "planted.mjs");
    writeFileSync(planted, `const base = "${RETIRED_BASE_URL}";\n`);
    expect(filesContaining([planted], RETIRED_BASE_URL).length).toBe(1);
  });

  test("⭐ the retired cloud estate appears in no skill text and no shipped default", () => {
    for (const suffix of RETIRED_CLOUD_HOST_SUFFIXES) {
      expect(filesContaining(files, suffix)).toEqual([]);
    }
  });

  test("⭐ threading.md no longer claims the reaction/issue-create routes do not exist", () => {
    // The under-claim that sent readers to `linearis` and the personal token for a write
    // the app actor could already make: linear-ack.mjs has been calling `reaction` through
    // the proxy since CTL-1961.
    const threading = readFileSync(
      join(REPO_ROOT, "plugins/dev/skills/ask/references/threading.md"),
      "utf8",
    );
    expect(threading).not.toContain("not yet — FLEET-30");
    expect(threading).toContain("`reaction`, `issue-create` | exists");
  });

  test("⭐ the ask template the plugin renders carries the cloud's how-to-answer heading", () => {
    // The parity item: a skill-filed ask and a cloud-filed ask must read the same to the
    // same human. Asserted here as well as in ask-verbs.test.mjs because this is the suite
    // that fails when someone deletes the line to shorten the body.
    const askMjs = readFileSync(join(REPO_ROOT, "plugins/dev/scripts/ask.mjs"), "utf8");
    expect(askMjs).toContain("**How to answer:**");
  });

  test("⭐ the config keys the deleted literals moved to are documented for an operator", () => {
    const docs = readFileSync(
      join(REPO_ROOT, "website/src/content/docs/reference/configuration.md"),
      "utf8",
    );
    expect(docs).toContain(BASE_URL_CONFIG_PATH);
    expect(docs).toContain(WRITE_BUDGET_CONFIG_PATH);
  });
});
