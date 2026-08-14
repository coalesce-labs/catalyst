// Unit tests for lock-resolution-audit.mjs (CTL-1831).
//
// The defect these lock down, measured on `mini` 2026-08-13 right after #3337
// moved bun.lock from @catalyst-cloud/schema@0.1.3 to 0.1.5:
//
//   bun install --frozen-lockfile  -> 0.1.3 on disk, "no changes", exit 0
//   bun install                    -> 0.1.3 on disk, "no changes", exit 0
//   bun install --force            -> 0.1.5 on disk
//
// Bun does not relink an existing node_modules when only a TRANSITIVE resolution
// changed, and both no-op commands exit 0 — so a successful-looking install is
// byte-indistinguishable from one that changed nothing. This module is the
// discriminator: it compares the lockfile's resolution against what the IMPORTING
// package actually resolves on disk.
//
// Every filesystem interaction is the single injected `resolvePackageFn` seam, so
// the whole audit is deterministically testable without a real node_modules.
//
// Run: bun test plugins/dev/scripts/broker/lock-resolution-audit.test.mjs

import { describe, test, expect } from "bun:test";
import {
  splitLockKey,
  parseLockPackages,
  changedResolutions,
  auditLockResolution,
} from "./lock-resolution-audit.mjs";

// ─── fixtures ────────────────────────────────────────────────────────────────
//
// Shaped exactly like this repo's own bun.lock: a 2-space `"packages": {` block
// whose entries are 4-space-indented `"<key>": ["<name>@<version>", …]` lines.

// `trustedDependencies` is deliberately present: it is a TOP-LEVEL key whose
// value is an array whose first element carries an `@`, so it matches the entry
// shape exactly. Without the packages-block gate it would be admitted as a
// package named `trustedDependencies` — the fixture has to contain a line that
// the gate is the ONLY thing rejecting, or the "only the packages block is
// scanned" assertion cannot fail.
const LOCK_0_1_3 = `{
  "lockfileVersion": 1,
  "trustedDependencies": ["esbuild@0.21.5"],
  "workspaces": {
    "": { "name": "catalyst" },
  },
  "packages": {
    "@catalyst-cloud/replicate": ["@catalyst-cloud/replicate@0.1.3", "", { "dependencies": { "@catalyst-cloud/schema": "^0.1.3" } }, "sha512-aaa=="],

    "@catalyst-cloud/schema": ["@catalyst-cloud/schema@0.1.3", "", { "dependencies": { "drizzle-orm": "0.44.7" } }, "sha512-bbb=="],

    "@catalyst-cloud/sdk": ["@catalyst-cloud/sdk@0.8.2", "", { "dependencies": { "@catalyst-cloud/replicate": "^0.1.3", "@catalyst-cloud/schema": "^0.1.3" } }, "sha512-ccc=="],

    "catalyst-execution-core": ["catalyst-execution-core@workspace:plugins/dev/scripts/execution-core"],

    "chalk": ["chalk@5.6.2", "", {}, "sha512-ddd=="],

    "chalk/ansi-styles": ["ansi-styles@4.3.0", "", { "dependencies": { "color-convert": "^2.0.1" } }, "sha512-eee=="],

    "ansi-styles": ["ansi-styles@6.2.3", "", {}, "sha512-fff=="],
  }
}
`;

// The ONLY difference from LOCK_0_1_3: the schema entry moves to 0.1.5. Nothing
// declares schema at the top level, so this is a transitive-only resolution change
// — the exact shape bun refuses to relink.
const LOCK_0_1_5 = LOCK_0_1_3.replace('"@catalyst-cloud/schema@0.1.3"', '"@catalyst-cloud/schema@0.1.5"');

// A stub resolver: `table` maps "<fromDir>|<id>" to {dir, version}. Anything not in
// the table is unresolvable (null) — the same three-valued shape the real
// createRequire-backed resolver reports.
function stubResolver(table) {
  const calls = [];
  const fn = (fromDir, id) => {
    calls.push({ fromDir, id });
    return table[`${fromDir}|${id}`] ?? null;
  };
  fn.calls = calls;
  return fn;
}

const ROOT = "/co";

// ─── splitLockKey ────────────────────────────────────────────────────────────
//
// bun keys the packages map by install LOCATION: `<id>` hoisted, `<parent>/<id>`
// nested, chaining deeper. Scoped names contain a `/` of their own, so a naive
// split on "/" cannot tell `@scope/pkg` from `parent/child`.

describe("splitLockKey", () => {
  test("a bare unscoped key is a one-element chain", () => {
    expect(splitLockKey("chalk")).toEqual(["chalk"]);
  });

  test("a bare SCOPED key is ONE element, not two", () => {
    expect(splitLockKey("@catalyst-cloud/schema")).toEqual(["@catalyst-cloud/schema"]);
  });

  test("a nested key splits parent from child", () => {
    expect(splitLockKey("chalk/ansi-styles")).toEqual(["chalk", "ansi-styles"]);
  });

  test("a deep chain mixing scoped and unscoped segments splits correctly", () => {
    expect(
      splitLockKey("@typescript-eslint/typescript-estree/minimatch/brace-expansion/balanced-match"),
    ).toEqual([
      "@typescript-eslint/typescript-estree",
      "minimatch",
      "brace-expansion",
      "balanced-match",
    ]);
  });

  test("a dangling scope with no package after it is null, never a guessed chain", () => {
    expect(splitLockKey("@scope")).toBeNull();
    expect(splitLockKey("chalk/@scope")).toBeNull();
  });

  test("an empty / non-string key is null", () => {
    expect(splitLockKey("")).toBeNull();
    expect(splitLockKey(null)).toBeNull();
  });
});

// ─── parseLockPackages ───────────────────────────────────────────────────────

describe("parseLockPackages", () => {
  test("parses id + version off a bare entry", () => {
    const p = parseLockPackages(LOCK_0_1_5);
    expect(p.conclusive).toBe(true);
    const schema = p.packages.get("@catalyst-cloud/schema");
    expect(schema.id).toBe("@catalyst-cloud/schema");
    expect(schema.version).toBe("0.1.5");
  });

  test("parses a NESTED entry's id off the value, not the key", () => {
    const p = parseLockPackages(LOCK_0_1_5);
    const nested = p.packages.get("chalk/ansi-styles");
    expect(nested.id).toBe("ansi-styles");
    expect(nested.version).toBe("4.3.0");
  });

  test("records each entry's declared dependency ids", () => {
    const p = parseLockPackages(LOCK_0_1_5);
    expect(p.packages.get("@catalyst-cloud/sdk").declaredDeps).toEqual([
      "@catalyst-cloud/replicate",
      "@catalyst-cloud/schema",
    ]);
  });

  test("a workspace: entry is recorded as a workspace link, not an installable version", () => {
    const p = parseLockPackages(LOCK_0_1_5);
    expect(p.packages.get("catalyst-execution-core").workspaceLink).toBe(true);
  });

  test("only the packages block is scanned — a top-level entry-shaped key is not a package", () => {
    const p = parseLockPackages(LOCK_0_1_5);
    expect(p.packages.has("trustedDependencies")).toBe(false);
    expect(p.packages.has("")).toBe(false);
    expect(p.packages.size).toBe(7);
  });

  test("empty / non-string text is INCONCLUSIVE with a reason, never an empty clean map", () => {
    for (const bad of ["", null, undefined, 42]) {
      const p = parseLockPackages(bad);
      expect(p.conclusive).toBe(false);
      expect(typeof p.reason).toBe("string");
    }
  });

  test("text with no packages block at all is INCONCLUSIVE, not zero-entries-clean", () => {
    const p = parseLockPackages('{\n  "lockfileVersion": 1,\n}\n');
    expect(p.conclusive).toBe(false);
    expect(p.reason).toContain("packages");
  });
});

// ─── changedResolutions ──────────────────────────────────────────────────────

describe("changedResolutions", () => {
  test("THE INCIDENT: a transitive-only version move is reported", () => {
    const c = changedResolutions(LOCK_0_1_3, LOCK_0_1_5);
    expect(c.conclusive).toBe(true);
    expect(c.entries).toEqual([
      { key: "@catalyst-cloud/schema", id: "@catalyst-cloud/schema", from: "0.1.3", to: "0.1.5" },
    ]);
  });

  test("an identical lockfile yields zero entries (conclusively)", () => {
    const c = changedResolutions(LOCK_0_1_5, LOCK_0_1_5);
    expect(c.conclusive).toBe(true);
    expect(c.entries).toEqual([]);
  });

  // WITH_LEFT_PAD is LOCK_0_1_5 plus one extra entry, so the add/remove pair
  // below can be driven in BOTH directions off the same two texts. (Deriving the
  // "removed" case by string-replacing an entry that is not in the text is a
  // no-op that compares a text with itself — an assertion that cannot fail.)
  const WITH_LEFT_PAD = LOCK_0_1_5.replace(
    '    "chalk": [',
    '    "left-pad": ["left-pad@1.3.0", "", {}, "sha512-ggg=="],\n\n    "chalk": [',
  );

  test("the added-entry fixture really differs from the base (control for the pair below)", () => {
    expect(WITH_LEFT_PAD).not.toBe(LOCK_0_1_5);
    expect(parseLockPackages(WITH_LEFT_PAD).packages.has("left-pad")).toBe(true);
    expect(parseLockPackages(LOCK_0_1_5).packages.has("left-pad")).toBe(false);
  });

  test("an ADDED entry is reported with from:null", () => {
    const c = changedResolutions(LOCK_0_1_5, WITH_LEFT_PAD);
    expect(c.entries).toEqual([{ key: "left-pad", id: "left-pad", from: null, to: "1.3.0" }]);
  });

  test("a REMOVED entry is not reported — nothing needs materializing for it", () => {
    const c = changedResolutions(WITH_LEFT_PAD, LOCK_0_1_5);
    expect(c.entries).toEqual([]);
  });

  test("a workspace: entry that changes path is NOT an installable resolution change", () => {
    const moved = LOCK_0_1_5.replace(
      "catalyst-execution-core@workspace:plugins/dev/scripts/execution-core",
      "catalyst-execution-core@workspace:plugins/dev/scripts/exec-core",
    );
    expect(changedResolutions(LOCK_0_1_5, moved).entries).toEqual([]);
  });

  test("an unparseable side is INCONCLUSIVE with a reason — never a silent zero", () => {
    const c = changedResolutions(null, LOCK_0_1_5);
    expect(c.conclusive).toBe(false);
    expect(typeof c.reason).toBe("string");
    expect(c.entries).toEqual([]);
  });
});

// ─── auditLockResolution ─────────────────────────────────────────────────────

describe("auditLockResolution", () => {
  // The three importer dirs the stubs use, in bun's isolated-linker shape:
  // node_modules/.bun/<name>@<version>+<hash>/node_modules/<name>.
  const SDK_DIR = `${ROOT}/node_modules/.bun/@catalyst-cloud+sdk@0.8.2+h/node_modules/@catalyst-cloud/sdk`;
  const REPLICATE_DIR = `${ROOT}/node_modules/.bun/@catalyst-cloud+replicate@0.1.3+h/node_modules/@catalyst-cloud/replicate`;

  // A tree that has been correctly relinked: both importers see 0.1.5.
  const RELINKED = {
    [`${ROOT}|@catalyst-cloud/sdk`]: { dir: SDK_DIR, version: "0.8.2" },
    [`${ROOT}|@catalyst-cloud/replicate`]: { dir: REPLICATE_DIR, version: "0.1.3" },
    [`${SDK_DIR}|@catalyst-cloud/schema`]: { dir: "/store/schema@0.1.5", version: "0.1.5" },
    [`${REPLICATE_DIR}|@catalyst-cloud/schema`]: { dir: "/store/schema@0.1.5", version: "0.1.5" },
  };

  // The measured post-no-op-install tree: the lockfile says 0.1.5, both importers
  // still resolve 0.1.3.
  const STALE = {
    ...RELINKED,
    [`${SDK_DIR}|@catalyst-cloud/schema`]: { dir: "/store/schema@0.1.3", version: "0.1.3" },
    [`${REPLICATE_DIR}|@catalyst-cloud/schema`]: { dir: "/store/schema@0.1.3", version: "0.1.3" },
  };

  test("THE INCIDENT: lockfile 0.1.5, importers still on 0.1.3 → mismatched", () => {
    const a = auditLockResolution({
      workspaceRoots: [ROOT],
      oldLockText: LOCK_0_1_3,
      newLockText: LOCK_0_1_5,
      resolvePackageFn: stubResolver(STALE),
    });
    expect(a.conclusive).toBe(true);
    expect(a.checked).toBe(1);
    expect(a.mismatched).toHaveLength(1);
    expect(a.mismatched[0].id).toBe("@catalyst-cloud/schema");
    expect(a.mismatched[0].expected).toBe("0.1.5");
    expect(a.mismatched[0].found).toContain("0.1.3");
    // The importer must be NAMED — an operator reading the event has to know which
    // package's resolved dependency is stale, not just that "something" is.
    expect(a.mismatched[0].importers).toContain("@catalyst-cloud/sdk");
  });

  test("after a forced relink the same audit is clean", () => {
    const a = auditLockResolution({
      workspaceRoots: [ROOT],
      oldLockText: LOCK_0_1_3,
      newLockText: LOCK_0_1_5,
      resolvePackageFn: stubResolver(RELINKED),
    });
    expect(a.conclusive).toBe(true);
    expect(a.checked).toBe(1);
    expect(a.mismatched).toEqual([]);
    expect(a.matched).toHaveLength(1);
  });

  test("the check reads the IMPORTER's resolution, not a hoisted top-level copy", () => {
    // A hoisted 0.1.5 exists at the workspace root while the SDK still resolves
    // 0.1.3 through its own node_modules. A check that read the top-level copy
    // would report clean here; this one must not.
    const hoistedFresh = {
      ...STALE,
      [`${ROOT}|@catalyst-cloud/schema`]: { dir: "/store/schema@0.1.5", version: "0.1.5" },
    };
    const a = auditLockResolution({
      workspaceRoots: [ROOT],
      oldLockText: LOCK_0_1_3,
      newLockText: LOCK_0_1_5,
      resolvePackageFn: stubResolver(hoistedFresh),
    });
    expect(a.mismatched).toHaveLength(1);
    expect(a.mismatched[0].found).toContain("0.1.3");
  });

  test("a NESTED key is judged from its parent only — a different hoisted copy is not a mismatch", () => {
    // chalk/ansi-styles moves 4.3.0 -> 4.3.1 while a hoisted ansi-styles@6.2.3
    // legitimately stays. Judging the nested entry from the workspace root would
    // report 6.2.3 as a mismatch and force a needless 1168-package re-extract.
    const oldText = LOCK_0_1_5;
    const newText = LOCK_0_1_5.replace('"ansi-styles@4.3.0"', '"ansi-styles@4.3.1"');
    const CHALK_DIR = `${ROOT}/node_modules/.bun/chalk@5.6.2+h/node_modules/chalk`;
    const a = auditLockResolution({
      workspaceRoots: [ROOT],
      oldLockText: oldText,
      newLockText: newText,
      resolvePackageFn: stubResolver({
        [`${ROOT}|chalk`]: { dir: CHALK_DIR, version: "5.6.2" },
        [`${ROOT}|ansi-styles`]: { dir: "/store/ansi-styles@6.2.3", version: "6.2.3" },
        [`${CHALK_DIR}|ansi-styles`]: { dir: "/store/ansi-styles@4.3.1", version: "4.3.1" },
      }),
    });
    expect(a.checked).toBe(1);
    expect(a.mismatched).toEqual([]);
    expect(a.matched).toHaveLength(1);
  });

  test("a nested key whose parent still resolves the OLD version IS a mismatch", () => {
    const newText = LOCK_0_1_5.replace('"ansi-styles@4.3.0"', '"ansi-styles@4.3.1"');
    const CHALK_DIR = `${ROOT}/node_modules/.bun/chalk@5.6.2+h/node_modules/chalk`;
    const a = auditLockResolution({
      workspaceRoots: [ROOT],
      oldLockText: LOCK_0_1_5,
      newLockText: newText,
      resolvePackageFn: stubResolver({
        [`${ROOT}|chalk`]: { dir: CHALK_DIR, version: "5.6.2" },
        [`${CHALK_DIR}|ansi-styles`]: { dir: "/store/ansi-styles@4.3.0", version: "4.3.0" },
      }),
    });
    expect(a.mismatched).toHaveLength(1);
    expect(a.mismatched[0].importers).toEqual(["chalk"]);
  });

  test("THE HIDDEN DEFECT: a wrong version at a SELECTED site is a mismatch even when the lockfile records it elsewhere", () => {
    // The lockfile keeps ansi-styles@6.2.3 bare AND ansi-styles@4.3.0 under
    // chalk; the BARE entry moves 6.2.3 -> 6.2.4. The workspace root must hold
    // the bare resolution — chalk's nested copy is judged at chalk, not here —
    // so a root still on 4.3.0 is precisely the stale placement this module
    // exists to catch.
    //
    // Excusing it as a benign `alternate` (because 4.3.0 is recorded SOMEWHERE)
    // was the bug: refreshPluginCheckout ignores alternates, never forces, and
    // leaves the bare resolution stale forever. Restoring the
    // `&& !lockedElsewhere.has(o.version)` filter on `wrong` fails this test.
    const newText = LOCK_0_1_5.replace('"ansi-styles@6.2.3"', '"ansi-styles@6.2.4"');
    const a = auditLockResolution({
      workspaceRoots: [ROOT],
      oldLockText: LOCK_0_1_5,
      newLockText: newText,
      resolvePackageFn: stubResolver({
        // Root resolves the OTHER version the lockfile still records (4.3.0).
        [`${ROOT}|ansi-styles`]: { dir: "/store/ansi-styles@4.3.0", version: "4.3.0" },
      }),
    });
    expect(a.matched).toEqual([]);
    expect(a.mismatched).toHaveLength(1);
    expect(a.mismatched[0].expected).toBe("6.2.4");
    expect(a.mismatched[0].found).toContain("4.3.0");
  });

  // ── the false positive the `alternate` excuse was really shielding ──
  //
  // A workspace MEMBER root legitimately resolves its own nested copy. This repo
  // really has three such keys (orch-monitor-ui/react, orch-monitor-ui/@types/react,
  // orch-monitor-ui/typescript) and plugins/dev/scripts/orch-monitor/ui is a
  // literal member passed in as a root — so this is a live shape, not a
  // hypothetical. The honest fix is to shed the site, not to excuse the version.

  const MEMBER_NEST_LOCK = `{
  "lockfileVersion": 1,
  "workspaces": {
    "": { "name": "catalyst" },
  },
  "packages": {
    "catalyst-execution-core": ["catalyst-execution-core@workspace:plugins/dev/scripts/execution-core"],

    "ansi-styles": ["ansi-styles@6.2.3", "", {}, "sha512-aaa=="],

    "catalyst-execution-core/ansi-styles": ["ansi-styles@4.3.0", "", {}, "sha512-bbb=="],
  }
}
`;
  const MEMBER_NEST_MOVED = MEMBER_NEST_LOCK.replace('"ansi-styles@6.2.3"', '"ansi-styles@6.2.4"');
  const MEMBER_DIR = `${ROOT}/plugins/dev/scripts/execution-core`;

  test("a member root with its OWN nested key for the id is SHED, not judged against the bare resolution", () => {
    // The member is entitled to 4.3.0 by `catalyst-execution-core/ansi-styles`.
    // Probing it would report a mismatch and force a needless re-extract on
    // every refresh that moves the bare entry. Deleting the
    // rootShadowedByOwnNestedKey guard fails this test.
    const a = auditLockResolution({
      workspaceRoots: [
        { dir: ROOT, name: "catalyst" },
        { dir: MEMBER_DIR, name: "catalyst-execution-core" },
      ],
      oldLockText: MEMBER_NEST_LOCK,
      newLockText: MEMBER_NEST_MOVED,
      resolvePackageFn: stubResolver({
        [`${ROOT}|ansi-styles`]: { dir: "/store/ansi-styles@6.2.4", version: "6.2.4" },
        [`${MEMBER_DIR}|ansi-styles`]: { dir: "/store/ansi-styles@4.3.0", version: "4.3.0" },
      }),
    });
    expect(a.mismatched).toEqual([]);
    expect(a.matched).toHaveLength(1);
    // The shed member must NOT be credited as a site that agreed, either.
    expect(a.matched[0].importers).toEqual([`workspace:${ROOT}`]);
  });

  test("a NAMED member root without a nested key for the id is still judged — the guard sheds one member, not all of them", () => {
    // The positive control for the test above: same wiring, but the member's
    // nested key names a DIFFERENT package, so nothing shields it and its stale
    // copy must surface. A guard that shed every member root passes the previous
    // test and fails this one.
    const otherNest = MEMBER_NEST_LOCK.replace(
      '"catalyst-execution-core/ansi-styles": ["ansi-styles@4.3.0"',
      '"catalyst-execution-core/chalk": ["chalk@4.3.0"',
    );
    const a = auditLockResolution({
      workspaceRoots: [
        { dir: ROOT, name: "catalyst" },
        { dir: MEMBER_DIR, name: "catalyst-execution-core" },
      ],
      oldLockText: otherNest,
      newLockText: otherNest.replace('"ansi-styles@6.2.3"', '"ansi-styles@6.2.4"'),
      resolvePackageFn: stubResolver({
        [`${ROOT}|ansi-styles`]: { dir: "/store/ansi-styles@6.2.4", version: "6.2.4" },
        [`${MEMBER_DIR}|ansi-styles`]: { dir: "/store/ansi-styles@4.3.0", version: "4.3.0" },
      }),
    });
    expect(a.mismatched).toHaveLength(1);
    expect(a.mismatched[0].importers).toEqual([`workspace:${MEMBER_DIR}`]);
  });

  test("an UNNAMED root falls back to shedding every root the nesting could apply to — inconclusive, never a false force", () => {
    // A caller that passes bare dir strings gives the audit no way to tell WHICH
    // member nests the id. Shedding is the safe direction: the site list empties
    // and the entry reports INCONCLUSIVE. A fallback that instead kept the roots
    // would report a mismatch here and force on every refresh.
    const a = auditLockResolution({
      workspaceRoots: [ROOT, MEMBER_DIR],
      oldLockText: MEMBER_NEST_LOCK,
      newLockText: MEMBER_NEST_MOVED,
      resolvePackageFn: stubResolver({
        [`${ROOT}|ansi-styles`]: { dir: "/store/ansi-styles@6.2.4", version: "6.2.4" },
        [`${MEMBER_DIR}|ansi-styles`]: { dir: "/store/ansi-styles@4.3.0", version: "4.3.0" },
      }),
    });
    expect(a.mismatched).toEqual([]);
    expect(a.matched).toEqual([]);
    expect(a.inconclusive).toHaveLength(1);
  });

  // ── deep install paths: the importer is reached hop by hop ──
  //
  // This repo's own bun.lock carries chains deeper than one nesting level
  // (measured: 48 nested keys, 5 of them deeper than one hop, max chain 4 —
  // `@typescript-eslint/typescript-estree/minimatch/brace-expansion/balanced-match`).
  // Resolving only the IMMEDIATE parent from a workspace root finds whichever
  // copy is root-visible, which is a different tree.

  const DEEP_LOCK = `{
  "lockfileVersion": 1,
  "packages": {
    "outer": ["outer@1.0.0", "", { "dependencies": { "mid": "^1" } }, "sha512-aaa=="],

    "outer/mid": ["mid@1.0.0", "", { "dependencies": { "leaf": "^1" } }, "sha512-bbb=="],

    "outer/mid/leaf": ["leaf@1.0.0", "", {}, "sha512-ccc=="],

    "mid": ["mid@2.0.0", "", { "dependencies": { "leaf": "^2" } }, "sha512-ddd=="],

    "leaf": ["leaf@2.0.0", "", {}, "sha512-eee=="],
  }
}
`;
  // Only the DEEP entry moves: outer/mid/leaf 1.0.0 -> 1.0.1.
  const DEEP_LOCK_MOVED = DEEP_LOCK.replace('"leaf@1.0.0"', '"leaf@1.0.1"');

  const OUTER_DIR = `${ROOT}/node_modules/.bun/outer@1.0.0+h/node_modules/outer`;
  const MID_UNDER_OUTER = `${ROOT}/node_modules/.bun/mid@1.0.0+h/node_modules/mid`;
  const MID_HOISTED = `${ROOT}/node_modules/.bun/mid@2.0.0+h/node_modules/mid`;

  test("a DEEP key probes the parent its install path names, not a separately hoisted copy of that parent", () => {
    // Both `mid@1.0.0` (under outer) and `mid@2.0.0` (hoisted) exist. The key
    // `outer/mid/leaf` names the FORMER. Resolving `mid` straight from the root
    // lands on the hoisted 2.0.0, whose leaf is 2.0.0 — the wrong tree, reported
    // as a defect in a tree that is perfectly correct.
    const a = auditLockResolution({
      workspaceRoots: [ROOT],
      oldLockText: DEEP_LOCK,
      newLockText: DEEP_LOCK_MOVED,
      resolvePackageFn: stubResolver({
        [`${ROOT}|outer`]: { dir: OUTER_DIR, version: "1.0.0" },
        [`${OUTER_DIR}|mid`]: { dir: MID_UNDER_OUTER, version: "1.0.0" },
        [`${ROOT}|mid`]: { dir: MID_HOISTED, version: "2.0.0" }, // the decoy
        [`${MID_UNDER_OUTER}|leaf`]: { dir: "/store/leaf@1.0.1", version: "1.0.1" },
        [`${MID_HOISTED}|leaf`]: { dir: "/store/leaf@2.0.0", version: "2.0.0" },
      }),
    });
    expect(a.checked).toBe(1);
    expect(a.mismatched).toEqual([]);
    expect(a.matched).toHaveLength(1);
    expect(a.matched[0].importers).toEqual(["outer/mid"]);
  });

  test("a DEEP key whose located parent is genuinely stale IS a mismatch — the walk still fails loudly", () => {
    // The positive control for the walk: identical wiring, but the copy the
    // install path names is stale. An implementation that located nothing would
    // report inconclusive here instead of a mismatch.
    const a = auditLockResolution({
      workspaceRoots: [ROOT],
      oldLockText: DEEP_LOCK,
      newLockText: DEEP_LOCK_MOVED,
      resolvePackageFn: stubResolver({
        [`${ROOT}|outer`]: { dir: OUTER_DIR, version: "1.0.0" },
        [`${OUTER_DIR}|mid`]: { dir: MID_UNDER_OUTER, version: "1.0.0" },
        [`${MID_UNDER_OUTER}|leaf`]: { dir: "/store/leaf@1.0.0", version: "1.0.0" },
      }),
    });
    expect(a.inconclusive).toEqual([]);
    expect(a.mismatched).toHaveLength(1);
    expect(a.mismatched[0].importers).toEqual(["outer/mid"]);
    expect(a.mismatched[0].found).toContain("1.0.0");
  });

  test("a DEEP key's parent that is NOT visible from the root is still located by walking the chain", () => {
    // No hoisted `mid` at all — the only way to reach the importer is
    // root -> outer -> mid. Resolving the immediate parent from the root returns
    // null here, and the entry would be written off as "could not locate".
    const a = auditLockResolution({
      workspaceRoots: [ROOT],
      oldLockText: DEEP_LOCK,
      newLockText: DEEP_LOCK_MOVED,
      resolvePackageFn: stubResolver({
        [`${ROOT}|outer`]: { dir: OUTER_DIR, version: "1.0.0" },
        [`${OUTER_DIR}|mid`]: { dir: MID_UNDER_OUTER, version: "1.0.0" },
        [`${MID_UNDER_OUTER}|leaf`]: { dir: "/store/leaf@1.0.1", version: "1.0.1" },
      }),
    });
    expect(a.inconclusive).toEqual([]);
    expect(a.matched).toHaveLength(1);
  });

  test("a broken hop in the chain is INCONCLUSIVE naming the install path, never a clean pass", () => {
    const a = auditLockResolution({
      workspaceRoots: [ROOT],
      oldLockText: DEEP_LOCK,
      newLockText: DEEP_LOCK_MOVED,
      resolvePackageFn: stubResolver({
        [`${ROOT}|outer`]: { dir: OUTER_DIR, version: "1.0.0" },
        // `mid` resolves from nowhere — the walk cannot complete.
      }),
    });
    expect(a.matched).toEqual([]);
    expect(a.mismatched).toEqual([]);
    expect(a.inconclusive).toHaveLength(1);
    expect(a.inconclusive[0].reason).toContain("outer/mid");
  });

  test("no importer resolves the id on disk → INCONCLUSIVE, never a clean pass", () => {
    const a = auditLockResolution({
      workspaceRoots: [ROOT],
      oldLockText: LOCK_0_1_3,
      newLockText: LOCK_0_1_5,
      resolvePackageFn: stubResolver({}), // nothing resolves at all
    });
    expect(a.mismatched).toEqual([]);
    expect(a.matched).toEqual([]);
    expect(a.inconclusive).toHaveLength(1);
    expect(a.inconclusive[0].id).toBe("@catalyst-cloud/schema");
    expect(typeof a.inconclusive[0].reason).toBe("string");
  });

  test("a missing OLD lockfile text is reported as inconclusive with a reason and audits nothing", () => {
    const resolver = stubResolver(STALE);
    const a = auditLockResolution({
      workspaceRoots: [ROOT],
      oldLockText: null,
      newLockText: LOCK_0_1_5,
      resolvePackageFn: resolver,
    });
    expect(a.conclusive).toBe(false);
    expect(typeof a.reason).toBe("string");
    expect(a.checked).toBe(0);
    // Nothing was probed — an audit that could not look must not touch the disk.
    expect(resolver.calls).toHaveLength(0);
  });

  test("an empty workspaceRoots list is INCONCLUSIVE — a zero-site loop cannot judge anything", () => {
    // [].every(p) is true; a site list that is empty must not read as "all clean".
    const a = auditLockResolution({
      workspaceRoots: [],
      oldLockText: LOCK_0_1_3,
      newLockText: LOCK_0_1_5,
      resolvePackageFn: stubResolver(STALE),
    });
    expect(a.conclusive).toBe(false);
    expect(a.mismatched).toEqual([]);
    expect(typeof a.reason).toBe("string");
  });

  test("zero changed entries → conclusive, checked 0, and no disk probes", () => {
    const resolver = stubResolver(STALE);
    const a = auditLockResolution({
      workspaceRoots: [ROOT],
      oldLockText: LOCK_0_1_5,
      newLockText: LOCK_0_1_5,
      resolvePackageFn: resolver,
    });
    expect(a.conclusive).toBe(true);
    expect(a.checked).toBe(0);
    expect(a.mismatched).toEqual([]);
    expect(resolver.calls).toHaveLength(0);
  });

  test("a throwing resolvePackageFn degrades to inconclusive, never crashes the refresh", () => {
    const a = auditLockResolution({
      workspaceRoots: [ROOT],
      oldLockText: LOCK_0_1_3,
      newLockText: LOCK_0_1_5,
      resolvePackageFn: () => {
        throw new Error("EACCES");
      },
    });
    expect(a.mismatched).toEqual([]);
    expect(a.inconclusive).toHaveLength(1);
  });
});
