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

  // ── shedding the member ROOT is not enough: its whole SUBTREE is shed ──
  //
  // MEASURED on this repo's real bun.lock + node_modules (node v25.8.2 / bun
  // 1.3.5, macOS 26.5, Ryans-MBP-2.rozich). bun's isolated linker writes a
  // SEPARATE, peer-disambiguated store entry per peer set. Reproducible on this
  // checkout — one bare lock entry, two store copies, different peer sets:
  //
  //   lock: "eslint": ["eslint@9.39.5", …]   (no nested `*/eslint` key at all)
  //   .bun/eslint@9.39.5+1a1acd4c2fa5b1a4/…  -> @eslint-community/eslint-utils
  //                                             @…+5e91b0bf22d6303b
  //   .bun/eslint@9.39.5+5e91b0bf22d6303b/…  -> @eslint-community/eslint-utils
  //                                             @…+bd61bba68491e3a8
  //
  // The lockfile records ONE bare entry covering both copies, so
  // `packages.has("<declarer>/<id>")` is FALSE and the declarer's own
  // nested-key exclusion cannot see the distinction. A declarer located by
  // first hit across every root lands on whichever copy some root can see —
  // measured, all 16 of `react`'s declarers are reachable ONLY through
  // `orch-monitor-ui`, the one member the lockfile shows nesting react at
  // 19.2.8. That produced `mismatched=1, expected 18.3.1, found ["19.2.8"], 16
  // importers` on a tree that is in fact correct, and `bun install --force`
  // (1168 packages, 4.21 s) does NOT clear it because the placement is
  // lockfile-determined.

  const SUBTREE_LOCK = `{
  "lockfileVersion": 1,
  "workspaces": {
    "": { "name": "catalyst" },
  },
  "packages": {
    "ui": ["ui@workspace:ui"],

    "react": ["react@18.3.1", "", {}, "sha512-aaa=="],

    "ui/react": ["react@19.2.8", "", {}, "sha512-bbb=="],

    "dnd": ["dnd@6.3.1", "", { "peerDependencies": { "react": "*" } }, "sha512-ccc=="],
  }
}
`;
  const SUBTREE_MOVED = SUBTREE_LOCK.replace('"react@18.3.1"', '"react@18.3.2"');
  const UI_DIR = `${ROOT}/ui`;
  // The two peer-disambiguated store copies of the SAME bare `dnd` entry.
  const DND_BARE = `${ROOT}/node_modules/.bun/dnd@6.3.1/node_modules/dnd`;
  const DND_PEERED = `${ROOT}/node_modules/.bun/dnd@6.3.1+005eabf3d8b6ef06/node_modules/dnd`;

  test("THE FALSE ERROR: a declarer reachable ONLY through a member root that nests the id is shed with that root", () => {
    // Exactly the measured shape: `dnd` is invisible from the bare-entitled root
    // and resolves only from `ui`, where it is the react-19 peered copy. The
    // tree is correct — root react is the moved 18.3.2 — so this must be
    // MATCHED. Locating the declarer from `roots` instead of `bareRoots` (the
    // `for (const root of bareRoots)` line in the declarer loop) reports a
    // mismatch here, which is the permanent, unforceable ERROR this test exists
    // to prevent.
    const a = auditLockResolution({
      workspaceRoots: [
        { dir: ROOT, name: "catalyst" },
        { dir: UI_DIR, name: "ui" },
      ],
      oldLockText: SUBTREE_LOCK,
      newLockText: SUBTREE_MOVED,
      resolvePackageFn: stubResolver({
        [`${ROOT}|react`]: { dir: "/store/react@18.3.2", version: "18.3.2" },
        [`${UI_DIR}|react`]: { dir: "/store/react@19.2.8", version: "19.2.8" },
        // `dnd` is NOT visible from the bare-entitled root — only from `ui`.
        [`${UI_DIR}|dnd`]: { dir: DND_PEERED, version: "6.3.1" },
        [`${DND_PEERED}|react`]: { dir: "/store/react@19.2.8", version: "19.2.8" },
      }),
    });
    expect(a.mismatched).toEqual([]);
    expect(a.matched).toHaveLength(1);
    // Only the bare-entitled root is credited; the shed subtree is not a site.
    expect(a.matched[0].importers).toEqual([`workspace:${ROOT}`]);
  });

  test("a declarer visible from BOTH roots is probed at the BARE-entitled copy, not the peered one", () => {
    // The positive control for the test above, and the guard against buying
    // silence by simply dropping declarers: here `dnd` IS reachable from the
    // bare-entitled root, so it stays a site — and the copy probed must be the
    // bare one (react 18.3.2), not `ui`'s peered copy. A fix that skipped every
    // declarer a shed root can also see would lose this site entirely and this
    // assertion on `importers` would fail.
    const a = auditLockResolution({
      workspaceRoots: [
        { dir: ROOT, name: "catalyst" },
        { dir: UI_DIR, name: "ui" },
      ],
      oldLockText: SUBTREE_LOCK,
      newLockText: SUBTREE_MOVED,
      resolvePackageFn: stubResolver({
        [`${ROOT}|react`]: { dir: "/store/react@18.3.2", version: "18.3.2" },
        [`${UI_DIR}|react`]: { dir: "/store/react@19.2.8", version: "19.2.8" },
        [`${ROOT}|dnd`]: { dir: DND_BARE, version: "6.3.1" },
        [`${UI_DIR}|dnd`]: { dir: DND_PEERED, version: "6.3.1" },
        [`${DND_BARE}|react`]: { dir: "/store/react@18.3.2", version: "18.3.2" },
        [`${DND_PEERED}|react`]: { dir: "/store/react@19.2.8", version: "19.2.8" },
      }),
    });
    expect(a.mismatched).toEqual([]);
    expect(a.matched).toHaveLength(1);
    expect(a.matched[0].importers).toEqual([`workspace:${ROOT}`, "dnd"]);
  });

  test("THE TRUE POSITIVE SURVIVES: a bare-entitled declarer still on the OLD version is a mismatch", () => {
    // Same wiring as the control above, but the bare copy of `dnd` genuinely
    // resolves the pre-move react. Shedding must not have widened into an
    // excuse: this is the stale placement the module exists to force on.
    const a = auditLockResolution({
      workspaceRoots: [
        { dir: ROOT, name: "catalyst" },
        { dir: UI_DIR, name: "ui" },
      ],
      oldLockText: SUBTREE_LOCK,
      newLockText: SUBTREE_MOVED,
      resolvePackageFn: stubResolver({
        [`${ROOT}|react`]: { dir: "/store/react@18.3.2", version: "18.3.2" },
        [`${UI_DIR}|react`]: { dir: "/store/react@19.2.8", version: "19.2.8" },
        [`${ROOT}|dnd`]: { dir: DND_BARE, version: "6.3.1" },
        [`${UI_DIR}|dnd`]: { dir: DND_PEERED, version: "6.3.1" },
        [`${DND_BARE}|react`]: { dir: "/store/react@18.3.1", version: "18.3.1" },
        [`${DND_PEERED}|react`]: { dir: "/store/react@19.2.8", version: "19.2.8" },
      }),
    });
    expect(a.matched).toEqual([]);
    expect(a.mismatched).toHaveLength(1);
    expect(a.mismatched[0].expected).toBe("18.3.2");
    expect(a.mismatched[0].found).toEqual(["18.3.1"]);
    expect(a.mismatched[0].importers).toEqual(["dnd"]);
  });

  test("a wholly-shed site list is INCONCLUSIVE naming the shed declarers — not folded into 'could not locate'", () => {
    // Nothing survives selection: the bare-entitled root cannot see react at
    // all, and the only declarer lives under the shed member. That is "I could
    // not look", and it must SAY which member subtree swallowed the site —
    // reporting `dnd` as merely unlocatable would read as an absent dependency
    // and hide that the audit deliberately declined to judge it.
    const a = auditLockResolution({
      workspaceRoots: [
        { dir: ROOT, name: "catalyst" },
        { dir: UI_DIR, name: "ui" },
      ],
      oldLockText: SUBTREE_LOCK,
      newLockText: SUBTREE_MOVED,
      resolvePackageFn: stubResolver({
        [`${UI_DIR}|react`]: { dir: "/store/react@19.2.8", version: "19.2.8" },
        [`${UI_DIR}|dnd`]: { dir: DND_PEERED, version: "6.3.1" },
        [`${DND_PEERED}|react`]: { dir: "/store/react@19.2.8", version: "19.2.8" },
      }),
    });
    expect(a.mismatched).toEqual([]);
    expect(a.matched).toEqual([]);
    expect(a.inconclusive).toHaveLength(1);
    expect(a.inconclusive[0].reason).toContain("reachable only through a workspace member that nests react");
    expect(a.inconclusive[0].reason).toContain("dnd");
    expect(a.inconclusive[0].reason).not.toContain("could not locate");
  });

  test("a declarer absent from EVERY root is still plain 'could not locate' — the shed reason is not a catch-all", () => {
    // The positive control for the reason above: `dnd` is on disk nowhere, so
    // the shed clause must NOT claim a member subtree swallowed it. A shed
    // check that reported every unlocatable declarer as shed passes the
    // previous test and fails this one.
    const a = auditLockResolution({
      workspaceRoots: [
        { dir: ROOT, name: "catalyst" },
        { dir: UI_DIR, name: "ui" },
      ],
      oldLockText: SUBTREE_LOCK,
      newLockText: SUBTREE_MOVED,
      resolvePackageFn: stubResolver({
        [`${UI_DIR}|react`]: { dir: "/store/react@19.2.8", version: "19.2.8" },
      }),
    });
    expect(a.inconclusive).toHaveLength(1);
    expect(a.inconclusive[0].reason).toContain("could not locate: dnd");
    expect(a.inconclusive[0].reason).not.toContain("reachable only through");
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

  // ── the declarer is EXCLUDED by its key but was LOCATED by its id ──
  //
  // MEASURED on this repo's real bun.lock + node_modules (node v25.8.2 / bun
  // 1.3.5, macOS 26.5). The tree is CORRECT on disk — both store copies exist
  // and both match the lockfile:
  //
  //   .bun/@opentelemetry+resources@2.8.0+e40b…/…/@opentelemetry/core  = 2.8.0
  //   .bun/@opentelemetry+resources@2.10.0+e40b…/…/@opentelemetry/core = 2.10.0
  //
  // The bare `@opentelemetry/resources` declarer IS correctly shed (the lockfile
  // carries `@opentelemetry/resources/@opentelemetry/core`). But
  // `@opentelemetry/sdk-logs/@opentelemetry/resources` — locked at 2.8.0, with
  // no nested core key of its own — is SELECTED, and was then located by
  // `resolve(root, "@opentelemetry/resources")`: a first hit from a bare root,
  // which lands on the 2.10.0 copy, i.e. the copy of the entry just shed. Six
  // such sites; a bare `@opentelemetry/core` move reported
  //
  //   ERROR plugin.checkout.deps_relink_failed  expected=2.8.0 found=["2.10.0"]
  //
  // on a tree no install can repair — a permanent ERROR, the react incident's
  // shape reached by a different route. Over all 689 bare ids, 5 had at least
  // one such site: 1 produced that live false ERROR and 4 read `matched` ONLY
  // because the wrong copy happened to agree (the latent false-clean below).

  const WRONGCOPY_LOCK = `{
  "lockfileVersion": 1,
  "workspaces": {
    "": { "name": "catalyst" },
  },
  "packages": {
    "core": ["core@2.8.0", "", {}, "sha512-aaa=="],

    "resources": ["resources@2.10.0", "", { "dependencies": { "core": "2.10.0" } }, "sha512-bbb=="],

    "resources/core": ["core@2.10.0", "", {}, "sha512-ccc=="],

    "sdk-logs": ["sdk-logs@0.219.0", "", { "dependencies": { "resources": "2.8.0" } }, "sha512-ddd=="],

    "sdk-logs/resources": ["resources@2.8.0", "", { "dependencies": { "core": "2.8.0" } }, "sha512-eee=="],
  }
}
`;
  // Only the BARE core entry moves. `resources/core` legitimately stays 2.10.0.
  const WRONGCOPY_MOVED = WRONGCOPY_LOCK.replace('"core@2.8.0"', '"core@2.8.1"');

  // The two store copies of `resources` the lockfile records separately.
  const RES_210 = `${ROOT}/node_modules/.bun/resources@2.10.0+h/node_modules/resources`;
  const RES_28 = `${ROOT}/node_modules/.bun/resources@2.8.0+h/node_modules/resources`;
  const SDKLOGS_DIR = `${ROOT}/node_modules/.bun/sdk-logs@0.219.0+h/node_modules/sdk-logs`;

  test("THE WRONG COPY: a declarer selected by its lock key is located by walking THAT key, not by a bare first hit", () => {
    // Exactly the measured shape. `sdk-logs/resources` (locked 2.8.0) is a
    // selected site for the bare core move; the bare first hit for `resources`
    // from the root is the 2.10.0 copy, whose core is legitimately 2.10.0.
    // Judging THAT against the moved bare 2.8.1 is the permanent false ERROR.
    // Restoring `located = resolve(root.dir, pkg.id)` in the declarer loop
    // fails this test.
    const a = auditLockResolution({
      workspaceRoots: [{ dir: ROOT, name: "catalyst" }],
      oldLockText: WRONGCOPY_LOCK,
      newLockText: WRONGCOPY_MOVED,
      resolvePackageFn: stubResolver({
        // The decoy: a bare `resources` hit from the root is the 2.10.0 copy.
        [`${ROOT}|resources`]: { dir: RES_210, version: "2.10.0" },
        [`${RES_210}|core`]: { dir: "/store/core@2.10.0", version: "2.10.0" },
        // The copy `sdk-logs/resources` actually names, reachable only through
        // sdk-logs — and correctly relinked to the moved core.
        [`${ROOT}|sdk-logs`]: { dir: SDKLOGS_DIR, version: "0.219.0" },
        [`${SDKLOGS_DIR}|resources`]: { dir: RES_28, version: "2.8.0" },
        [`${RES_28}|core`]: { dir: "/store/core@2.8.1", version: "2.8.1" },
        [`${SDKLOGS_DIR}|core`]: { dir: "/store/core@2.8.1", version: "2.8.1" },
      }),
    });
    expect(a.mismatched).toEqual([]);
    expect(a.matched).toHaveLength(1);
    // The site is named by its lock KEY, so the two `resources` declarers are
    // distinguishable in the report at all.
    expect(a.matched[0].importers).toContain("sdk-logs/resources");
    expect(a.matched[0].importers).not.toContain("resources");
  });

  test("THE LATENT FALSE CLEAN: the wrong copy AGREEING is not evidence either — the right copy is still judged", () => {
    // The other direction of the same defect, and the half that fixing the
    // ERROR alone would leave open. Same wiring, but now the decoy 2.10.0 copy
    // coincidentally resolves the MOVED core (2.8.1) while the copy
    // `sdk-logs/resources` really names is stale at 2.8.0. Probing the wrong
    // copy reports a clean tree; probing the right one reports the real defect.
    // Measured: 4 ids on this repo's real tree read `matched` only because a
    // copy the lock key never selected happened to agree.
    const a = auditLockResolution({
      workspaceRoots: [{ dir: ROOT, name: "catalyst" }],
      oldLockText: WRONGCOPY_LOCK,
      newLockText: WRONGCOPY_MOVED,
      resolvePackageFn: stubResolver({
        [`${ROOT}|resources`]: { dir: RES_210, version: "2.10.0" },
        [`${RES_210}|core`]: { dir: "/store/core@2.8.1", version: "2.8.1" }, // coincidental agreement
        [`${ROOT}|sdk-logs`]: { dir: SDKLOGS_DIR, version: "0.219.0" },
        [`${SDKLOGS_DIR}|resources`]: { dir: RES_28, version: "2.8.0" },
        [`${RES_28}|core`]: { dir: "/store/core@2.8.0", version: "2.8.0" }, // the REAL stale placement
        [`${SDKLOGS_DIR}|core`]: { dir: "/store/core@2.8.1", version: "2.8.1" },
      }),
    });
    expect(a.matched).toEqual([]);
    expect(a.mismatched).toHaveLength(1);
    expect(a.mismatched[0].expected).toBe("2.8.1");
    expect(a.mismatched[0].found).toEqual(["2.8.0"]);
    expect(a.mismatched[0].importers).toEqual(["sdk-logs/resources"]);
  });

  test("a declarer whose own key path lands on a DISAGREEING copy is not evidence — inconclusive, naming the wrong copy", () => {
    // The walk cannot reach the copy the key names: `sdk-logs` on disk is a
    // stale 0.9.9, not the 0.219.0 the lockfile records, so everything below it
    // is a different subtree. That observation says nothing about the bare core
    // move — it must not be a mismatch and must not be a silent match.
    const a = auditLockResolution({
      workspaceRoots: [{ dir: ROOT, name: "catalyst" }],
      oldLockText: WRONGCOPY_LOCK,
      newLockText: WRONGCOPY_MOVED,
      resolvePackageFn: stubResolver({
        [`${ROOT}|sdk-logs`]: { dir: SDKLOGS_DIR, version: "0.9.9" }, // NOT the locked 0.219.0
        [`${SDKLOGS_DIR}|resources`]: { dir: RES_28, version: "2.8.0" },
        [`${RES_28}|core`]: { dir: "/store/core@0.0.1", version: "0.0.1" },
      }),
    });
    expect(a.matched).toEqual([]);
    expect(a.mismatched).toEqual([]);
    expect(a.inconclusive).toHaveLength(1);
    expect(a.inconclusive[0].reason).toContain("probed the wrong copy");
    expect(a.inconclusive[0].reason).toContain("install path sdk-logs");
    expect(a.inconclusive[0].reason).toContain("0.219.0");
    expect(a.inconclusive[0].reason).toContain("0.9.9");
    expect(a.inconclusive[0].wrongCopy).toHaveLength(1);
  });

  test("a wrong-copy site is carried on the verdict even when other sites DID answer — never silently dropped", () => {
    // The root answers correctly, so the entry is `matched`. The shed-for-wrong-
    // copy declarer must still be NAMED on that verdict: dropping it silently is
    // exactly how the latent false-clean stayed invisible for four ids.
    const a = auditLockResolution({
      workspaceRoots: [{ dir: ROOT, name: "catalyst" }],
      oldLockText: WRONGCOPY_LOCK,
      newLockText: WRONGCOPY_MOVED,
      resolvePackageFn: stubResolver({
        [`${ROOT}|core`]: { dir: "/store/core@2.8.1", version: "2.8.1" },
        [`${ROOT}|sdk-logs`]: { dir: SDKLOGS_DIR, version: "0.9.9" }, // wrong copy
        [`${SDKLOGS_DIR}|resources`]: { dir: RES_28, version: "2.8.0" },
        [`${RES_28}|core`]: { dir: "/store/core@2.8.0", version: "2.8.0" },
      }),
    });
    expect(a.mismatched).toEqual([]);
    expect(a.matched).toHaveLength(1);
    expect(a.matched[0].importers).toEqual([`workspace:${ROOT}`]);
    expect(a.matched[0].wrongCopy).toHaveLength(1);
    expect(a.matched[0].wrongCopy[0]).toContain("sdk-logs/resources");
  });

  // ── entitlement climbs: an ANCESTOR's nested key governs too ──
  //
  // MEASURED on this repo's real lockfile: bun nests one level from a top-level
  // entry, so `@opentelemetry/exporter-trace-otlp-http/@opentelemetry/
  // sdk-trace-base` (2.8.0) and `@opentelemetry/exporter-trace-otlp-http/
  // @opentelemetry/resources` (2.8.0) are SIBLINGS under the exporter and there
  // is no `…/sdk-trace-base/@opentelemetry/resources` key at all. sdk-trace-base
  // is entitled to resources 2.8.0 by its PARENT's key while the bare
  // `@opentelemetry/resources` entry is 2.10.0.

  const ANCESTOR_LOCK = `{
  "lockfileVersion": 1,
  "workspaces": {
    "": { "name": "catalyst" },
  },
  "packages": {
    "resources": ["resources@2.10.0", "", {}, "sha512-aaa=="],

    "exporter": ["exporter@0.219.0", "", { "dependencies": { "resources": "2.8.0", "sdk-trace-base": "2.8.0" } }, "sha512-bbb=="],

    "exporter/resources": ["resources@2.8.0", "", {}, "sha512-ccc=="],

    "exporter/sdk-trace-base": ["sdk-trace-base@2.8.0", "", { "dependencies": { "resources": "2.8.0" } }, "sha512-ddd=="],
  }
}
`;
  const ANCESTOR_MOVED = ANCESTOR_LOCK.replace('"resources@2.10.0"', '"resources@2.10.1"');
  const EXPORTER_DIR = `${ROOT}/node_modules/.bun/exporter@0.219.0+h/node_modules/exporter`;
  const STB_DIR = `${ROOT}/node_modules/.bun/sdk-trace-base@2.8.0+h/node_modules/sdk-trace-base`;

  test("a declarer entitled by an ANCESTOR's nested key is shed too — not only by its own", () => {
    // `exporter/sdk-trace-base` has no nested resources key of its own, so an
    // own-key-only exclusion selects it, and the walk then correctly locates its
    // legitimate 2.8.0 resources and reports `expected 2.10.1, found ["2.8.0"]`
    // on a correct tree. Narrowing governingEntryFor to the declarer's own key
    // (dropping the ancestor loop) fails this test.
    const a = auditLockResolution({
      workspaceRoots: [{ dir: ROOT, name: "catalyst" }],
      oldLockText: ANCESTOR_LOCK,
      newLockText: ANCESTOR_MOVED,
      resolvePackageFn: stubResolver({
        [`${ROOT}|resources`]: { dir: "/store/resources@2.10.1", version: "2.10.1" },
        [`${ROOT}|exporter`]: { dir: EXPORTER_DIR, version: "0.219.0" },
        [`${EXPORTER_DIR}|sdk-trace-base`]: { dir: STB_DIR, version: "2.8.0" },
        [`${STB_DIR}|resources`]: { dir: "/store/resources@2.8.0", version: "2.8.0" },
        [`${EXPORTER_DIR}|resources`]: { dir: "/store/resources@2.8.0", version: "2.8.0" },
      }),
    });
    expect(a.mismatched).toEqual([]);
    expect(a.matched).toHaveLength(1);
    expect(a.matched[0].importers).toEqual([`workspace:${ROOT}`]);
  });

  test("the ancestor shed does not swallow a declarer no ancestor nests — the positive control", () => {
    // Same lockfile, but the audited move is on `sdk-trace-base`, which NO
    // ancestor key nests (`exporter/sdk-trace-base` is the declarer's own
    // identity here, not a nested resolution of the audited id). A shed that
    // fired on any nested key anywhere would lose this site and read
    // inconclusive; the stale copy must surface as a mismatch instead.
    const stbMoved = ANCESTOR_LOCK.replace('"exporter@0.219.0"', '"exporter@0.219.1"');
    const a = auditLockResolution({
      workspaceRoots: [{ dir: ROOT, name: "catalyst" }],
      oldLockText: ANCESTOR_LOCK,
      newLockText: stbMoved,
      resolvePackageFn: stubResolver({
        [`${ROOT}|exporter`]: { dir: EXPORTER_DIR, version: "0.219.0" }, // genuinely stale
      }),
    });
    expect(a.matched).toEqual([]);
    expect(a.mismatched).toHaveLength(1);
    expect(a.mismatched[0].expected).toBe("0.219.1");
    expect(a.mismatched[0].found).toEqual(["0.219.0"]);
  });

  test("a DEEP key's hop that lands on a disagreeing copy stops the walk — never followed into the wrong subtree", () => {
    // `outer` on disk is a stale 9.9.9, not the locked 1.0.0, so its mid/leaf is
    // a different tree entirely. Following it reports a confident mismatch off a
    // subtree the install path never named. Deleting the version check in
    // walkInstallPath turns this inconclusive into exactly that false mismatch.
    const a = auditLockResolution({
      workspaceRoots: [ROOT],
      oldLockText: DEEP_LOCK,
      newLockText: DEEP_LOCK_MOVED,
      resolvePackageFn: stubResolver({
        [`${ROOT}|outer`]: { dir: OUTER_DIR, version: "9.9.9" }, // NOT the locked 1.0.0
        [`${OUTER_DIR}|mid`]: { dir: MID_UNDER_OUTER, version: "1.0.0" },
        [`${MID_UNDER_OUTER}|leaf`]: { dir: "/store/leaf@7.7.7", version: "7.7.7" },
      }),
    });
    expect(a.matched).toEqual([]);
    expect(a.mismatched).toEqual([]);
    expect(a.inconclusive).toHaveLength(1);
    expect(a.inconclusive[0].reason).toContain("probed the wrong copy");
    expect(a.inconclusive[0].reason).toContain("install path outer");
  });

  test("a hop no lockfile entry governs is INCONCLUSIVE — right and wrong copy cannot be told apart", () => {
    // bun's keys are prefix-closed on every lockfile measured here (745 keys, 48
    // nested, 0 missing prefixes), so this shape should not occur — which is
    // precisely why it must fail CLOSED rather than be waved through. `ghost` is
    // a hop with no entry of its own.
    const orphanLock = `{
  "lockfileVersion": 1,
  "packages": {
    "leaf": ["leaf@2.0.0", "", {}, "sha512-aaa=="],

    "ghost/leaf": ["leaf@1.0.0", "", {}, "sha512-bbb=="],
  }
}
`;
    const orphanMoved = orphanLock.replace('"leaf@1.0.0"', '"leaf@1.0.1"');
    const GHOST_DIR = `${ROOT}/node_modules/.bun/ghost@1.0.0+h/node_modules/ghost`;
    const a = auditLockResolution({
      workspaceRoots: [ROOT],
      oldLockText: orphanLock,
      newLockText: orphanMoved,
      resolvePackageFn: stubResolver({
        [`${ROOT}|ghost`]: { dir: GHOST_DIR, version: "1.0.0" },
        [`${GHOST_DIR}|leaf`]: { dir: "/store/leaf@1.0.1", version: "1.0.1" },
      }),
    });
    expect(a.matched).toEqual([]);
    expect(a.mismatched).toEqual([]);
    expect(a.inconclusive).toHaveLength(1);
    expect(a.inconclusive[0].reason).toContain("no lockfile entry governs it");
  });

  test("a workspace: hop is exempt from the version check — a link has no installed version to compare", () => {
    // A member root's lock entry records `ui@workspace:ui`, never a semver, so
    // comparing the member's package.json version against it rejects EVERY
    // key nested under a workspace member. Dropping the workspaceLink exemption
    // in walkInstallPath turns this matched into an inconclusive.
    const a = auditLockResolution({
      workspaceRoots: [{ dir: ROOT, name: "catalyst" }],
      oldLockText: SUBTREE_LOCK,
      newLockText: SUBTREE_LOCK.replace('"react@19.2.8"', '"react@19.2.9"'),
      resolvePackageFn: stubResolver({
        [`${ROOT}|ui`]: { dir: UI_DIR, version: "0.0.0" }, // the member's own manifest version
        [`${UI_DIR}|react`]: { dir: "/store/react@19.2.9", version: "19.2.9" },
      }),
    });
    expect(a.mismatched).toEqual([]);
    expect(a.inconclusive).toEqual([]);
    expect(a.matched).toHaveLength(1);
    expect(a.matched[0].importers).toEqual(["ui"]);
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
