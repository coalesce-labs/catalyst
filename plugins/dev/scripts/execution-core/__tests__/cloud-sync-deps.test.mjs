// cloud-sync-deps.test.mjs — CTL-1659. The loaded-dependency identity record, the
// three-link skew comparator, the dep-skew restart budget, and the pure daemon-side
// predicate (classifyDepSkew, which lives beside classifyStall in cloud-sync-telemetry).
//
// The defect under test: a dependency fix lands on main, the updater pulls it, the
// install succeeds — and the RUNNING cloud-sync writer keeps serving the old modules
// indefinitely, with nothing red. Every assertion below therefore comes in pairs: the
// negative ("no skew") is only evidence when the SAME instrument is shown producing the
// positive ("skew") on a case known to carry it. A comparator that can only ever say
// "clean" is exactly the failure mode this ticket exists to remove.
//
// Run: cd plugins/dev/scripts/execution-core && bun test cloud-sync-deps
import { describe, test, expect } from "bun:test";
import {
  CRITICAL_DEPS,
  DEP_SKEW_REASON,
  DEP_SKEW_RESTART_EVENT,
  DEP_SKEW_WOULD_RESTART_EVENT,
  RESTART_LEDGER_UNREADABLE,
  captureLoadedDeps,
  classifyRestartBudget,
  depSkewEventEnvelope,
  depSkewFields,
  evaluateDepSkew,
  findLockRoot,
  decodeBunStoreDir,
  lockKeyForPackageJsonPath,
  lockLocationKeyFor,
  lockedVersionForKey,
  provenLockKey,
  splitBunStorePath,
  workspaceDirsFromLock,
  lockedVersionsFor,
  readDepsBreadcrumb,
  readRestartLedger,
  SKEW_LINKS,
  recordRestartAttempt,
  sha256File,
  writeDepsBreadcrumb,
} from "../cloud-sync-deps.mjs";
import { classifyDepSkew, resolveDepSkewMode } from "../cloud-sync-telemetry.mjs";

const NOW = 1_800_000_000_000;
const ROOT = "/opt/plugin-source";
const LOCK = `${ROOT}/bun.lock`;
const SDK_ENTRY = `${ROOT}/node_modules/@catalyst-cloud/sdk/dist/node.js`;
const SDK_PKG = `${ROOT}/node_modules/@catalyst-cloud/sdk/package.json`;

// A minimal but REAL-SHAPED bun.lock excerpt (the "packages" map entry format bun
// writes): `"<key>": ["<name>@<version>", …]`. Nested resolutions carry a slashed key.
const LOCK_TEXT = `{
  "lockfileVersion": 1,
  "workspaces": { "": { "dependencies": { "@catalyst-cloud/sdk": "^0.8.2" } } },
  "packages": {
    "@catalyst-cloud/sdk": ["@catalyst-cloud/sdk@0.8.2", "", { "dependencies": {} }, "sha512-aaa=="],
    "@catalyst-cloud/sdk/@catalyst-cloud/schema": ["@catalyst-cloud/schema@0.1.5", "", {}, "sha512-bbb=="],
    "pino": ["pino@9.6.0", "", {}, "sha512-ccc=="],
  }
}`;

// ─── fixtures ───────────────────────────────────────────────────────────────
// A whole synthetic filesystem, so nothing here touches a real disk or resolver.
function fs(over = {}) {
  return {
    [LOCK]: LOCK_TEXT,
    [SDK_ENTRY]: "// sdk entry bytes v1\n",
    [SDK_PKG]: JSON.stringify({ name: "@catalyst-cloud/sdk", version: "0.8.2" }),
    ...over,
  };
}

function deps(files, over = {}) {
  return {
    startDir: `${ROOT}/plugins/dev/scripts/execution-core`,
    deps: [{ id: "@catalyst-cloud/sdk", specifier: "@catalyst-cloud/sdk/node" }],
    resolveModule: (spec) => {
      if (spec === "@catalyst-cloud/sdk/node") return SDK_ENTRY;
      throw new Error(`Cannot find module '${spec}'`);
    },
    fileExists: (p) => Object.prototype.hasOwnProperty.call(files, p),
    readText: (p) => {
      if (!Object.prototype.hasOwnProperty.call(files, p)) throw new Error(`ENOENT ${p}`);
      return files[p];
    },
    readJson: (p) => {
      if (!Object.prototype.hasOwnProperty.call(files, p)) throw new Error(`ENOENT ${p}`);
      return JSON.parse(files[p]);
    },
    pid: 4242,
    now: () => NOW,
    ...over,
  };
}

describe("sha256File", () => {
  test("hashes content, and DIFFERENT bytes produce a DIFFERENT digest (the discriminator)", () => {
    const a = sha256File("/a", { readText: () => "alpha" });
    const b = sha256File("/b", { readText: () => "beta" });
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
    // Positive control for "identical bytes → identical digest": without this the
    // inequality below could be produced by a hasher that just returns randomness.
    expect(sha256File("/c", { readText: () => "alpha" })).toBe(a);
    expect(b).not.toBe(a);
  });

  test("unreadable file → null (never a fabricated digest a comparison could pass on)", () => {
    expect(sha256File("/nope", { readText: () => { throw new Error("ENOENT"); } })).toBeNull();
  });
});

describe("findLockRoot", () => {
  test("walks up to the directory holding bun.lock", () => {
    const files = fs();
    const r = findLockRoot(`${ROOT}/node_modules/@catalyst-cloud/sdk/dist`, {
      fileExists: (p) => Object.prototype.hasOwnProperty.call(files, p),
    });
    expect(r).toEqual({ root: ROOT, lockPath: LOCK });
  });

  test("no lockfile anywhere above → null (not a guessed root)", () => {
    expect(findLockRoot("/tmp/x/y", { fileExists: () => false })).toBeNull();
  });
});

describe("captureLoadedDeps", () => {
  test("records what was ACTUALLY resolved — path, version, entry hash — plus the root lockfile hash", () => {
    const files = fs();
    const rec = captureLoadedDeps(deps(files));
    expect(rec.degraded).toBe(false);
    expect(rec.pid).toBe(4242);
    expect(rec.ts).toBe(NOW);
    expect(rec.root).toBe(ROOT);
    expect(rec.lockPath).toBe(LOCK);
    expect(rec.lockHash).toBe(sha256File(LOCK, { readText: () => LOCK_TEXT }));
    expect(rec.packages).toHaveLength(1);
    const p = rec.packages[0];
    expect(p.id).toBe("@catalyst-cloud/sdk");
    expect(p.resolvedPath).toBe(SDK_ENTRY);
    expect(p.packageJsonPath).toBe(SDK_PKG);
    expect(p.version).toBe("0.8.2");
    expect(p.entryHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("the version comes from the RESOLVED path's package.json, not from the lockfile", () => {
    // The CTL-1646 shadowed-install class: the lockfile says one thing and the bytes
    // on disk say another. A capture derived from the lockfile re-manufactures the lie.
    const files = fs({ [SDK_PKG]: JSON.stringify({ name: "@catalyst-cloud/sdk", version: "0.7.0" }) });
    expect(captureLoadedDeps(deps(files)).packages[0].version).toBe("0.7.0");
  });

  test("an unresolvable package degrades the record and NAMES the failure — never a silent clean record", () => {
    const files = fs();
    const rec = captureLoadedDeps(deps(files, { resolveModule: () => { throw new Error("Cannot find module"); } }));
    expect(rec.degraded).toBe(true);
    expect(rec.degradedReasons.join(" ")).toMatch(/@catalyst-cloud\/sdk/);
    // Positive control: the same instrument on a resolvable package is NOT degraded.
    expect(captureLoadedDeps(deps(files)).degraded).toBe(false);
  });

  test("an EMPTY critical-dep list is degraded, not a vacuous clean capture ([].every(p) === true)", () => {
    const files = fs();
    const rec = captureLoadedDeps(deps(files, { deps: [] }));
    expect(rec.degraded).toBe(true);
    expect(rec.degradedReasons.join(" ")).toMatch(/no critical dependencies/i);
  });

  test("no lockfile above the daemon → degraded with a null lockHash (nothing to compare against)", () => {
    const files = fs();
    delete files[LOCK];
    const rec = captureLoadedDeps(deps(files));
    expect(rec.lockHash).toBeNull();
    expect(rec.degraded).toBe(true);
  });

  test("the shipped CRITICAL_DEPS registry is non-empty and names the SDK cloud-sync loads", () => {
    expect(CRITICAL_DEPS.length).toBeGreaterThan(0);
    expect(CRITICAL_DEPS.map((d) => d.id)).toContain("@catalyst-cloud/sdk");
  });
});

describe("deps breadcrumb io", () => {
  test("atomic tmp+rename, and reads back what was written", () => {
    const written = {};
    const renames = [];
    const rec = captureLoadedDeps(deps(fs()));
    expect(
      writeDepsBreadcrumb("/tmp/deps.json", rec, {
        writeFile: (p, c) => { written[p] = c; },
        rename: (a, b) => { renames.push([a, b]); written[b] = written[a]; },
      }),
    ).toBe(true);
    expect(renames).toEqual([["/tmp/deps.json.tmp", "/tmp/deps.json"]]);
    const back = readDepsBreadcrumb("/tmp/deps.json", { readText: (p) => written[p] });
    expect(back.lockHash).toBe(rec.lockHash);
    expect(back.packages[0].version).toBe("0.8.2");
  });

  test("write failure is fail-open (false, never throws) — the breadcrumb must not block boot", () => {
    expect(writeDepsBreadcrumb("/tmp/x", {}, { writeFile: () => { throw new Error("EROFS"); } })).toBe(false);
  });

  test("absent / malformed breadcrumb reads as null, never as an empty-but-valid record", () => {
    expect(readDepsBreadcrumb("/nope", { readText: () => { throw new Error("ENOENT"); } })).toBeNull();
    expect(readDepsBreadcrumb("/bad", { readText: () => "{not json" })).toBeNull();
  });
});

describe("lockedVersionsFor", () => {
  test("extracts every locked resolution for a package id (hoisted AND nested keys)", () => {
    const v = lockedVersionsFor(LOCK_TEXT, "@catalyst-cloud/sdk");
    expect(v.conclusive).toBe(true);
    expect(v.versions).toEqual(["0.8.2"]);
    const s = lockedVersionsFor(LOCK_TEXT, "@catalyst-cloud/schema");
    expect(s.conclusive).toBe(true);
    expect(s.versions).toEqual(["0.1.5"]);
  });

  test("a package absent from the lockfile is INCONCLUSIVE, never 'no skew'", () => {
    const v = lockedVersionsFor(LOCK_TEXT, "@catalyst-cloud/nonexistent");
    expect(v.conclusive).toBe(false);
    expect(v.reason).toMatch(/not found/i);
    // Positive control on the same instrument + same text: a present package IS conclusive.
    expect(lockedVersionsFor(LOCK_TEXT, "pino").conclusive).toBe(true);
  });
});

// ─── the three-link comparator ──────────────────────────────────────────────
function evalDeps(files, over = {}) {
  const record = captureLoadedDeps(deps(files));
  return {
    breadcrumb: record,
    readText: (p) => {
      if (!Object.prototype.hasOwnProperty.call(files, p)) throw new Error(`ENOENT ${p}`);
      return files[p];
    },
    readJson: (p) => {
      if (!Object.prototype.hasOwnProperty.call(files, p)) throw new Error(`ENOENT ${p}`);
      return JSON.parse(files[p]);
    },
    processCommandForPid: (pid) => (pid === 4242 ? "bun /opt/plugin-source/plugins/dev/scripts/execution-core/cloud-sync.mjs" : null),
    // CTL-1931: the healthy default — this node is configured to serve from the root the
    // fixture writer actually loaded from. Tests for the OTHER links keep their meaning;
    // the serving-root link gets its own block below, which overrides this.
    expectedRoots: [ROOT],
    ...over,
  };
}
const linkOf = (r, link) => r.verdicts.find((v) => v.link === link);

describe("evaluateDepSkew — link 1: loaded vs locked", () => {
  test("lockfile unchanged since boot → ok", () => {
    const files = fs();
    const r = evaluateDepSkew(evalDeps(files));
    expect(linkOf(r, "loaded-vs-locked").status).toBe("ok");
    expect(r.skew).toBe(false);
  });

  test("THE CTL-1659 INCIDENT: lockfile changed after boot → skew, naming both digests", () => {
    const files = fs();
    const args = evalDeps(files);
    files[LOCK] = LOCK_TEXT.replace("0.8.2", "0.8.3"); // a dep fix landed + installed
    const r = evaluateDepSkew(args);
    const v = linkOf(r, "loaded-vs-locked");
    expect(v.status).toBe("skew");
    expect(r.skew).toBe(true);
    expect(v.detail).toMatch(/lockfile/i);
  });

  test("SAME version, DIFFERENT bytes still skews — the digest, not the version string, is the verdict", () => {
    // A repointed tarball / workspace-link / git dep ships new bytes under the same
    // semver. A version-equality comparator is permanently non-discriminating there.
    const files = fs();
    const args = evalDeps(files);
    files[LOCK] = LOCK_TEXT.replace("sha512-aaa==", "sha512-zzz==");
    expect(linkOf(evaluateDepSkew(args), "loaded-vs-locked").status).toBe("skew");
  });

  test("lockfile now unreadable → INCONCLUSIVE, never ok", () => {
    const files = fs();
    const args = evalDeps(files);
    delete files[LOCK];
    const r = evaluateDepSkew(args);
    expect(linkOf(r, "loaded-vs-locked").status).toBe("inconclusive");
    expect(r.inconclusive).toBe(true);
  });
});

describe("evaluateDepSkew — link 2: installed vs locked", () => {
  test("installed version is one of the locked resolutions → ok", () => {
    expect(linkOf(evaluateDepSkew(evalDeps(fs())), "installed-vs-locked").status).toBe("ok");
  });

  test("partial install / shadowed install: on-disk version not in the lockfile → skew NAMING package + both versions", () => {
    const files = fs();
    const args = evalDeps(files);
    files[SDK_PKG] = JSON.stringify({ name: "@catalyst-cloud/sdk", version: "0.7.0" });
    const v = linkOf(evaluateDepSkew(args), "installed-vs-locked");
    expect(v.status).toBe("skew");
    expect(v.detail).toContain("@catalyst-cloud/sdk");
    expect(v.detail).toContain("0.7.0"); // installed
    expect(v.detail).toContain("0.8.2"); // locked
  });

  test("package.json missing on disk now (SIGKILL'd install residue) → INCONCLUSIVE, never ok", () => {
    const files = fs();
    const args = evalDeps(files);
    delete files[SDK_PKG];
    expect(linkOf(evaluateDepSkew(args), "installed-vs-locked").status).toBe("inconclusive");
  });

  test("zero packages compared → INCONCLUSIVE (the vacuous-loop trap), never ok", () => {
    const files = fs();
    const args = evalDeps(files);
    args.breadcrumb = { ...args.breadcrumb, packages: [] };
    const v = linkOf(evaluateDepSkew(args), "installed-vs-locked");
    expect(v.status).toBe("inconclusive");
    expect(v.detail).toMatch(/no package/i);
  });
});

describe("evaluateDepSkew — link 3: breadcrumb ↔ process identity", () => {
  test("pid names the live cloud-sync writer → ok", () => {
    expect(linkOf(evaluateDepSkew(evalDeps(fs())), "record-identity").status).toBe("ok");
  });

  test("pid dead → INCONCLUSIVE and links 1/2 are NOT reported as ok (stale evidence)", () => {
    const r = evaluateDepSkew(evalDeps(fs(), { processCommandForPid: () => null }));
    expect(linkOf(r, "record-identity").status).toBe("inconclusive");
    expect(r.inconclusive).toBe(true);
    expect(r.verdicts.every((v) => v.status !== "ok")).toBe(true);
  });

  test("pid RECYCLED onto another program → INCONCLUSIVE (fail-closed identity, not bare kill -0)", () => {
    const r = evaluateDepSkew(evalDeps(fs(), { processCommandForPid: () => "/usr/bin/vim notes.txt" }));
    expect(linkOf(r, "record-identity").status).toBe("inconclusive");
  });
});

describe("evaluateDepSkew — absent evidence", () => {
  test("no breadcrumb at all → INCONCLUSIVE, never a clean bill of health", () => {
    const r = evaluateDepSkew({ breadcrumb: null });
    expect(r.inconclusive).toBe(true);
    expect(r.skew).toBe(false);
    expect(r.verdicts.every((v) => v.status !== "ok")).toBe(true);
    // Positive control: the SAME function CAN return an all-ok result.
    expect(evaluateDepSkew(evalDeps(fs())).verdicts.every((v) => v.status === "ok")).toBe(true);
  });
});

// ─── the daemon-side predicate ──────────────────────────────────────────────
describe("classifyDepSkew", () => {
  const base = {
    bootLockHash: "sha256:aaa",
    currentLockHash: "sha256:bbb",
    consecutiveMismatches: 2,
    sustainedTicks: 2,
    uptimeMs: 600_000,
    uptimeFloorMs: 120_000,
    mode: "enforce",
    budgetAllowed: true,
  };

  test("sustained mismatch under enforce → restart", () => {
    const c = classifyDepSkew(base);
    expect(c.skewed).toBe(true);
    expect(c.sustained).toBe(true);
    expect(c.wouldRestart).toBe(true);
    expect(c.restart).toBe(true);
  });

  test("identical hashes → no skew (the healthy steady state)", () => {
    const c = classifyDepSkew({ ...base, currentLockHash: base.bootLockHash });
    expect(c.skewed).toBe(false);
    expect(c.restart).toBe(false);
  });

  test("an unknown hash on EITHER side never asserts skew — a failed read must not kill the writer", () => {
    for (const over of [{ bootLockHash: null }, { currentLockHash: null }, { bootLockHash: "" }, { currentLockHash: undefined }]) {
      const c = classifyDepSkew({ ...base, ...over });
      expect(c.known).toBe(false);
      expect(c.skewed).toBe(false);
      expect(c.restart).toBe(false);
    }
    // Positive control: with both hashes known and different, the SAME call DOES assert.
    expect(classifyDepSkew(base).skewed).toBe(true);
  });

  test("a single-tick mismatch (mid-write lockfile) does not act — sustained needs >= sustainedTicks", () => {
    const c = classifyDepSkew({ ...base, consecutiveMismatches: 1 });
    expect(c.skewed).toBe(true);
    expect(c.sustained).toBe(false);
    expect(c.restart).toBe(false);
  });

  test("uptime floor: a just-booted writer never self-restarts on skew", () => {
    expect(classifyDepSkew({ ...base, uptimeMs: 5_000 }).restart).toBe(false);
  });

  test("shadow (the default) detects and would-restart but NEVER exits", () => {
    const c = classifyDepSkew({ ...base, mode: "shadow" });
    expect(c.wouldRestart).toBe(true);
    expect(c.restart).toBe(false);
  });

  test("off is fully dormant — no would-restart, no restart", () => {
    const c = classifyDepSkew({ ...base, mode: "off" });
    expect(c.wouldRestart).toBe(false);
    expect(c.restart).toBe(false);
  });

  test("an exhausted restart budget holds the exit and NAMES why (the loop terminator)", () => {
    const c = classifyDepSkew({ ...base, budgetAllowed: false });
    expect(c.wouldRestart).toBe(true);
    expect(c.restart).toBe(false);
    expect(c.reason).toMatch(/budget/i);
  });

  test("resolveDepSkewMode: recognized values pass through; anything else settles at the shadow default", () => {
    expect(resolveDepSkewMode("enforce")).toBe("enforce");
    expect(resolveDepSkewMode("off")).toBe("off");
    expect(resolveDepSkewMode("shadow")).toBe("shadow");
    for (const raw of [undefined, null, "", "ENFORCE!", "on", "true"]) expect(resolveDepSkewMode(raw)).toBe("shadow");
  });
});

// ─── the restart budget (durable loop terminator) ───────────────────────────
describe("dep-skew restart budget", () => {
  test("first trip is allowed; the cap holds the second within the window", () => {
    expect(classifyRestartBudget({ ledger: null, now: NOW, windowMs: 21_600_000, maxRestarts: 1 }).allowed).toBe(true);
    const spent = { ts: NOW - 60_000, count: 1 };
    const held = classifyRestartBudget({ ledger: spent, now: NOW, windowMs: 21_600_000, maxRestarts: 1 });
    expect(held.allowed).toBe(false);
    expect(held.reason).toMatch(/budget|cap/i);
  });

  test("an expired window re-arms the budget (a success resets the counter as time passes)", () => {
    const old = { ts: NOW - 21_600_001, count: 5 };
    expect(classifyRestartBudget({ ledger: old, now: NOW, windowMs: 21_600_000, maxRestarts: 1 }).allowed).toBe(true);
  });

  test("a malformed / future-dated ledger is treated as spent, not as free budget (fail-closed)", () => {
    for (const ledger of [{ ts: "nope", count: 1 }, { ts: NOW + 60_000, count: 1 }, { count: 3 }]) {
      expect(classifyRestartBudget({ ledger, now: NOW, windowMs: 21_600_000, maxRestarts: 1 }).allowed).toBe(false);
    }
  });

  // The fixtures above all carry `count >= maxRestarts`, so the COUNT branch alone returns
  // allowed:false and the timestamp guard is never the thing under test — deleting the guard
  // outright leaves that test green (measured: `if (!Number.isFinite(ts) || ts > now)` →
  // `if (false)` survived the whole file at 44 pass / 0 fail). The discriminating input is a
  // ledger whose timestamp is unusable while its COUNT is still under the cap: with the guard
  // the ledger is refused, without it `now - NaN >= windowMs` is false (NaN comparisons are
  // always false), `count 0 >= 1` is false, and the fail-closed refusal degrades into a
  // FULL budget — the loop terminator silently disarmed on exactly the corrupt/clock-skewed
  // ledger it exists to survive.
  test("an unusable timestamp refuses the restart EVEN WHEN the count is under the cap (isolates the guard from the count branch)", () => {
    const underCap = [
      { ledger: { ts: "nope", count: 0 }, why: "non-numeric ts (Number('nope') → NaN)" },
      { ledger: { ts: NaN, count: 0 }, why: "literal NaN ts" },
      { ledger: { ts: NOW + 60_000, count: 0 }, why: "future-dated ts (clock skew / a tampered ledger)" },
      { ledger: { count: 0 }, why: "ts absent entirely" },
    ];
    for (const { ledger, why } of underCap) {
      const v = classifyRestartBudget({ ledger, now: NOW, windowMs: 21_600_000, maxRestarts: 1 });
      expect(v.allowed, `${why}: an unusable timestamp must NOT read as free budget`).toBe(false);
      // The REASON separates the two branches: the timestamp guard says "no usable
      // timestamp", the count branch says "exhausted". Asserting the text is what keeps this
      // test honest about WHICH branch refused — an outcome-only assertion would pass again
      // the moment someone widened the count branch to cover it.
      expect(v.reason, `${why}: must be refused BY THE TIMESTAMP GUARD, not by the count cap`).toMatch(/no usable timestamp/i);
      expect(v.count, `${why}: the guard reports an unknown count, never a fabricated 0`).toBeNull();
    }
  });

  // POSITIVE CONTROL for the negative above: the same call shape, same maxRestarts, with a
  // ledger whose timestamp IS usable and whose count is under the cap, DOES return free
  // budget. Without this, a `classifyRestartBudget` that returned `allowed:false` for
  // literally every input would satisfy every assertion in this describe block.
  test("POSITIVE CONTROL — a well-formed in-window ledger under the cap still grants budget", () => {
    const v = classifyRestartBudget({ ledger: { ts: NOW - 60_000, count: 0 }, now: NOW, windowMs: 21_600_000, maxRestarts: 1 });
    expect(v.allowed).toBe(true);
    expect(v.count).toBe(0);
    expect(v.reason).toBeNull();
  });

  // `ts === now` is the boundary the guard's `ts > now` draws: a ledger written in this very
  // millisecond is legitimate, not future-dated, so it must fall through to the count branch.
  // Pinned because tightening the comparison to `>=` would refuse a same-millisecond write.
  test("a ledger stamped at exactly `now` is NOT future-dated — it falls through to the count branch", () => {
    expect(classifyRestartBudget({ ledger: { ts: NOW, count: 0 }, now: NOW, windowMs: 21_600_000, maxRestarts: 1 }).allowed).toBe(true);
    const held = classifyRestartBudget({ ledger: { ts: NOW, count: 1 }, now: NOW, windowMs: 21_600_000, maxRestarts: 1 });
    expect(held.allowed).toBe(false);
    expect(held.reason).toMatch(/exhausted/i); // refused by the COUNT branch, proving the fall-through
  });

  test("recordRestartAttempt increments within the window and resets past it", () => {
    const store = {};
    const io = {
      writeFile: (p, c) => { store[p] = c; },
      rename: (a, b) => { store[b] = store[a]; },
    };
    const first = recordRestartAttempt("/tmp/led.json", { ledger: null, now: NOW, windowMs: 1000 }, io);
    expect(first).toEqual({ ts: NOW, count: 1 });
    const second = recordRestartAttempt("/tmp/led.json", { ledger: first, now: NOW + 500, windowMs: 1000 }, io);
    expect(second.count).toBe(2);
    expect(second.ts).toBe(NOW); // window anchor stays at the first attempt
    const afterWindow = recordRestartAttempt("/tmp/led.json", { ledger: second, now: NOW + 5000, windowMs: 1000 }, io);
    expect(afterWindow).toEqual({ ts: NOW + 5000, count: 1 });
    expect(JSON.parse(store["/tmp/led.json"]).count).toBe(1);
  });

  test("a ledger that could NOT be persisted returns null — the loop terminator fails CLOSED", () => {
    // If the budget is not durable there is no terminator, so the caller must decline the
    // restart. Declining is never destructive: a skewed-but-running writer is exactly
    // today's behavior, which the doctor check now names.
    expect(recordRestartAttempt("/tmp/led.json", { ledger: null, now: NOW }, { writeFile: () => { throw new Error("EROFS"); } })).toBeNull();
    // Positive control: the same call with a working writer DOES return a ledger.
    expect(recordRestartAttempt("/tmp/led.json", { ledger: null, now: NOW }, { writeFile: () => {}, rename: () => {} })).toEqual({ ts: NOW, count: 1 });
  });
});

// ─── the ledger READ is tri-state (absent ≠ unreadable) ─────────────────────
//
// Round-2 finding 1. `readRestartLedger` returned the SAME `null` for "no file" and for
// "a file I could not read or parse", and `classifyRestartBudget(null)` grants a FULL
// budget. So in enforce mode a corrupt or momentarily-unreadable ledger permitted another
// restart past the cap and then overwrote the evidence — the durable loop terminator
// disarmed by exactly the corruption it exists to survive. Each negative below is paired
// with the positive control on the same instrument.
const enoent = () => { throw Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" }); };

describe("readRestartLedger — absent and unreadable are DIFFERENT answers", () => {
  test("a genuinely ABSENT ledger (ENOENT) reads as null → full budget (the normal first trip)", () => {
    expect(readRestartLedger("/nope", { readText: enoent })).toBeNull();
    // …and that null is what grants budget, which is why the cases below must NOT be null.
    expect(classifyRestartBudget({ ledger: readRestartLedger("/nope", { readText: enoent }), now: NOW, maxRestarts: 1 }).allowed).toBe(true);
  });

  test("a ledger that EXISTS but does not parse is UNREADABLE, and the budget is DECLINED", () => {
    const led = readRestartLedger("/bad", { readText: () => "{not json" });
    expect(led).not.toBeNull();
    expect(led).toBe(RESTART_LEDGER_UNREADABLE);
    const v = classifyRestartBudget({ ledger: led, now: NOW, maxRestarts: 1 });
    expect(v.allowed, "a corrupt ledger must never read as free budget").toBe(false);
    expect(v.reason).toMatch(/could not be read or parsed/i);
    expect(v.count).toBeNull();
  });

  test("a NON-ENOENT read failure (EACCES/EIO) is UNREADABLE, not absent — 'I could not look' ≠ 'not there'", () => {
    for (const code of ["EACCES", "EIO", undefined]) {
      const led = readRestartLedger("/x", { readText: () => { throw Object.assign(new Error(code ?? "boom"), code ? { code } : {}); } });
      expect(led, `code=${code}`).toBe(RESTART_LEDGER_UNREADABLE);
      expect(classifyRestartBudget({ ledger: led, now: NOW, maxRestarts: 1 }).allowed, `code=${code}`).toBe(false);
    }
  });

  test("valid JSON that is not a ledger OBJECT (null / array / scalar) is UNREADABLE, never absent", () => {
    for (const text of ["null", "[]", "42", '"ts"']) {
      expect(readRestartLedger("/x", { readText: () => text }), text).toBe(RESTART_LEDGER_UNREADABLE);
    }
  });

  test("POSITIVE CONTROL — a well-formed ledger file reads back as its object and still grades normally", () => {
    const led = readRestartLedger("/ok", { readText: () => JSON.stringify({ ts: NOW - 60_000, count: 0 }) });
    expect(led).toEqual({ ts: NOW - 60_000, count: 0 });
    expect(classifyRestartBudget({ ledger: led, now: NOW, maxRestarts: 1 }).allowed).toBe(true);
  });
});

// ─── raw types before coercion ──────────────────────────────────────────────
//
// Round-2 finding 2, and it is the SAME defect class the round-1 remediation just fixed one
// level up: a guard that looks right while the fixture cannot discriminate. Every case here
// therefore keeps `count` UNDER the cap, so the count branch can never be the thing that
// refuses, and asserts the REASON so the test names WHICH guard fired.
describe("classifyRestartBudget — raw field TYPES are checked before any Number() coercion", () => {
  test("a syntactically valid `{ts: null}` must not become an epoch anchor and re-arm a full budget", () => {
    // Number(null) === 0 → finite → not future → `now - 0 >= windowMs` → "expired window"
    // → allowed:true, count:0. A FULL budget handed out by a corrupt ledger.
    const v = classifyRestartBudget({ ledger: { ts: null, count: 0 }, now: NOW, windowMs: 21_600_000, maxRestarts: 1 });
    expect(v.allowed, "`ts: null` coerces to 0 and reads as an expired window").toBe(false);
    expect(v.reason).toMatch(/no usable timestamp/i);
    expect(v.count).toBeNull();
  });

  test("every non-number `ts` that Number() would launder into a finite value is refused", () => {
    // Each of these coerces to a finite number: [] → 0, true → 1, "0" → 0, "" → 0.
    for (const ts of [null, [], true, false, "0", "", "1800000000000"]) {
      const v = classifyRestartBudget({ ledger: { ts, count: 0 }, now: NOW, windowMs: 21_600_000, maxRestarts: 1 });
      expect(v.allowed, `ts=${JSON.stringify(ts)} must not read as a usable anchor`).toBe(false);
      expect(v.reason, `ts=${JSON.stringify(ts)}`).toMatch(/no usable timestamp/i);
    }
  });

  test("a missing or non-numeric `count` is refused BY THE COUNT GUARD, not coerced to zero", () => {
    // Number(undefined) || 0 === 0 and Number(null) || 0 === 0 → "nothing spent yet".
    for (const ledger of [{ ts: NOW - 60_000 }, { ts: NOW - 60_000, count: null }, { ts: NOW - 60_000, count: "1" }, { ts: NOW - 60_000, count: 1.5 }, { ts: NOW - 60_000, count: -1 }, { ts: NOW - 60_000, count: NaN }]) {
      const v = classifyRestartBudget({ ledger, now: NOW, windowMs: 21_600_000, maxRestarts: 1 });
      expect(v.allowed, `count=${JSON.stringify(ledger.count)} must not read as "nothing spent yet"`).toBe(false);
      // Naming the branch is what keeps this isolated: the timestamp here is perfectly
      // usable, so a refusal blamed on the timestamp would mean the test is measuring the
      // wrong guard.
      expect(v.reason, `count=${JSON.stringify(ledger.count)}`).toMatch(/no usable count/i);
      expect(v.count).toBeNull();
    }
  });

  test("the type gate runs BEFORE the expired-window shortcut — a bogus count cannot re-arm on an untrusted anchor", () => {
    // An expired window normally returns allowed:true without ever reading `count`; that
    // shortcut must not be reachable from a ledger whose fields failed validation.
    const v = classifyRestartBudget({ ledger: { ts: NOW - 21_600_001, count: "99" }, now: NOW, windowMs: 21_600_000, maxRestarts: 1 });
    expect(v.allowed).toBe(false);
    expect(v.reason).toMatch(/no usable count/i);
  });

  test("POSITIVE CONTROL — the same shapes with real numbers still grant and still exhaust", () => {
    expect(classifyRestartBudget({ ledger: { ts: NOW - 60_000, count: 0 }, now: NOW, windowMs: 21_600_000, maxRestarts: 1 }).allowed).toBe(true);
    expect(classifyRestartBudget({ ledger: { ts: NOW - 60_000, count: 1 }, now: NOW, windowMs: 21_600_000, maxRestarts: 1 }).allowed).toBe(false);
    expect(classifyRestartBudget({ ledger: { ts: NOW - 21_600_001, count: 9 }, now: NOW, windowMs: 21_600_000, maxRestarts: 1 }).allowed).toBe(true);
  });

  test("recordRestartAttempt applies the SAME gate — a coercible-but-invalid prior never seeds the next ledger", () => {
    const io = { writeFile: () => {}, rename: () => {} };
    // Number("7") === 7, so the old coercion would have written count 8 and carried the
    // untrusted anchor forward. The gate resets to a fresh, honest window instead.
    expect(recordRestartAttempt("/tmp/led.json", { ledger: { ts: NOW - 60_000, count: "7" }, now: NOW, windowMs: 21_600_000 }, io)).toEqual({ ts: NOW, count: 1 });
    expect(recordRestartAttempt("/tmp/led.json", { ledger: RESTART_LEDGER_UNREADABLE, now: NOW, windowMs: 21_600_000 }, io)).toEqual({ ts: NOW, count: 1 });
    // POSITIVE CONTROL: a valid in-window prior IS carried forward and incremented.
    expect(recordRestartAttempt("/tmp/led.json", { ledger: { ts: NOW - 60_000, count: 7 }, now: NOW, windowMs: 21_600_000 }, io)).toEqual({ ts: NOW - 60_000, count: 8 });
  });
});

// ─── the captured entry digest is actually COMPARED ─────────────────────────
//
// Round-2 finding 3, and the most important of the five: `captureLoadedDeps` records
// `entryHash` expressly as the discriminator ("the VERDICT keys on the digest") and NO
// comparator read it back. A repointed mutable artifact / workspace output changes the bytes
// the running process holds while the lockfile TEXT and the package version are identical —
// so loaded-vs-locked reported ok, doctor PASSed, and the writer never restarted.
describe("evaluateDepSkew — the captured ENTRY DIGEST is compared, not merely recorded", () => {
  test("THE UNCOMPARED-DISCRIMINATOR DEFECT: same lockfile, same version, DIFFERENT entry bytes → skew", () => {
    const files = fs();
    const args = evalDeps(files);
    // Nothing else moves: the lockfile text is byte-identical (so its digest matches) and
    // package.json still says 0.8.2 (so installed-vs-locked is clean). ONLY the bytes the
    // process loaded have changed underneath it.
    files[SDK_ENTRY] = "// sdk entry bytes v2 — a repointed tarball, same semver\n";
    const r = evaluateDepSkew(args);
    const v = linkOf(r, "loaded-vs-locked");
    expect(v.status, "changed entry bytes under an unchanged lockfile MUST skew").toBe("skew");
    expect(r.skew).toBe(true);
    expect(v.detail).toContain("@catalyst-cloud/sdk");
    expect(v.detail).toMatch(/entry bytes changed/i);
    expect(v.detail).toContain(SDK_ENTRY);
    // The lockfile-digest half is genuinely clean here, which is what makes this a proof
    // that the ENTRY digest is what produced the verdict.
    expect(linkOf(r, "installed-vs-locked").status).toBe("ok");
  });

  test("the loaded entry file is unreadable NOW → INCONCLUSIVE, never ok (bytes UNKNOWN ≠ unchanged)", () => {
    const files = fs();
    const args = evalDeps(files);
    delete files[SDK_ENTRY];
    const v = linkOf(evaluateDepSkew(args), "loaded-vs-locked");
    expect(v.status).toBe("inconclusive");
    expect(v.detail).toMatch(/unreadable now/i);
  });

  test("a boot record carrying NO entry digest is INCONCLUSIVE — an unmeasured discriminator is not a clean one", () => {
    const files = fs();
    const args = evalDeps(files);
    args.breadcrumb = { ...args.breadcrumb, packages: args.breadcrumb.packages.map((p) => ({ ...p, entryHash: null })) };
    expect(linkOf(evaluateDepSkew(args), "loaded-vs-locked").status).toBe("inconclusive");
  });

  test("ZERO recorded packages cannot produce an ok loaded-vs-locked ([].every(p) === true)", () => {
    const files = fs();
    const args = evalDeps(files);
    args.breadcrumb = { ...args.breadcrumb, packages: [] };
    const v = linkOf(evaluateDepSkew(args), "loaded-vs-locked");
    expect(v.status).toBe("inconclusive");
    expect(v.detail).toMatch(/zero entry-digest comparisons/i);
  });

  test("POSITIVE CONTROL — unchanged bytes under an unchanged lockfile still report ok, naming the count", () => {
    const v = linkOf(evaluateDepSkew(evalDeps(fs())), "loaded-vs-locked");
    expect(v.status).toBe("ok");
    expect(v.detail).toMatch(/entry digest\(s\) are unchanged/i);
  });
});

// ─── the installed package is matched to ITS OWN lock resolution ────────────
//
// Round-2 finding 4. `locked.versions.includes(installed)` accepts ANY resolution anywhere
// in the lockfile, so a stale ROOT install is excused by an unrelated NESTED entry that
// happens to carry the same version — hiding the shadowed/partial install this link exists
// to detect.
const LOCK_TEXT_MULTI = `{
  "lockfileVersion": 1,
  "packages": {
    "@catalyst-cloud/sdk": ["@catalyst-cloud/sdk@0.8.2", "", { "dependencies": {} }, "sha512-aaa=="],
    "legacy-tool/@catalyst-cloud/sdk": ["@catalyst-cloud/sdk@0.7.0", "", {}, "sha512-ddd=="],
    "pino": ["pino@9.6.0", "", {}, "sha512-ccc=="],
  }
}`;

describe("lockKeyForPackageJsonPath — install location → bun lock key", () => {
  test("a hoisted install keys on the bare id; a nested one chains its parents", () => {
    expect(lockKeyForPackageJsonPath(ROOT, `${ROOT}/node_modules/pino/package.json`)).toBe("pino");
    expect(lockKeyForPackageJsonPath(ROOT, SDK_PKG)).toBe("@catalyst-cloud/sdk");
    expect(lockKeyForPackageJsonPath(ROOT, `${ROOT}/node_modules/legacy-tool/node_modules/@catalyst-cloud/sdk/package.json`)).toBe("legacy-tool/@catalyst-cloud/sdk");
    expect(lockKeyForPackageJsonPath(ROOT, `${ROOT}/node_modules/@babel/core/node_modules/semver/package.json`)).toBe("@babel/core/semver");
    expect(lockKeyForPackageJsonPath(ROOT, `${ROOT}/node_modules/a/node_modules/b/node_modules/c/package.json`)).toBe("a/b/c");
    expect(lockKeyForPackageJsonPath(`${ROOT}/`, SDK_PKG), "a trailing slash on the root is not a different root").toBe("@catalyst-cloud/sdk");
  });

  test("anything the path cannot answer returns null (→ the caller reports inconclusive), never a guess", () => {
    // Outside the serving root; a workspace link that is not under node_modules at all
    // (its bun key is the WORKSPACE's package name, which no path can supply); a dangling
    // scope directory; a root that is not a string.
    expect(lockKeyForPackageJsonPath(ROOT, "/elsewhere/node_modules/pino/package.json")).toBeNull();
    expect(lockKeyForPackageJsonPath(ROOT, `${ROOT}/plugins/dev/scripts/execution-core/package.json`)).toBeNull();
    expect(lockKeyForPackageJsonPath(ROOT, `${ROOT}/node_modules/@scope/package.json`)).toBeNull();
    expect(lockKeyForPackageJsonPath(null, SDK_PKG)).toBeNull();
    expect(lockKeyForPackageJsonPath(ROOT, null)).toBeNull();
    // POSITIVE CONTROL on the same instrument: a well-formed path DOES resolve, so the
    // nulls above are measurements rather than a function that only ever returns null.
    expect(lockKeyForPackageJsonPath(ROOT, SDK_PKG)).toBe("@catalyst-cloud/sdk");
  });
});

describe("lockedVersionForKey — the ONE resolution at a specific install location", () => {
  test("reads the exact key, and does NOT accept a sibling nesting of the same id", () => {
    expect(lockedVersionForKey(LOCK_TEXT_MULTI, "@catalyst-cloud/sdk", "@catalyst-cloud/sdk")).toEqual({ conclusive: true, version: "0.8.2", reason: null });
    expect(lockedVersionForKey(LOCK_TEXT_MULTI, "legacy-tool/@catalyst-cloud/sdk", "@catalyst-cloud/sdk").version).toBe("0.7.0");
    // The old any-occurrence matcher conflates exactly these two.
    expect(lockedVersionsFor(LOCK_TEXT_MULTI, "@catalyst-cloud/sdk").versions).toEqual(["0.7.0", "0.8.2"]);
  });

  test("an absent key or an underivable one is INCONCLUSIVE, never 'no drift'", () => {
    expect(lockedVersionForKey(LOCK_TEXT_MULTI, "other/@catalyst-cloud/sdk", "@catalyst-cloud/sdk").conclusive).toBe(false);
    expect(lockedVersionForKey(LOCK_TEXT_MULTI, null, "@catalyst-cloud/sdk").reason).toMatch(/could not be associated/i);
    expect(lockedVersionForKey("", "@catalyst-cloud/sdk", "@catalyst-cloud/sdk").conclusive).toBe(false);
  });
});

describe("evaluateDepSkew — installed-vs-locked matches the package to ITS OWN lock entry", () => {
  test("A STALE ROOT INSTALL IS NOT EXCUSED BY A NESTED RESOLUTION OF THE SAME VERSION", () => {
    // Root locks 0.8.2, a nested copy locks 0.7.0, the ROOT install is at 0.7.0. The
    // any-occurrence matcher reports ok on the strength of the nested entry — precisely the
    // shadowed/partial install this link exists to detect.
    const files = fs({ [LOCK]: LOCK_TEXT_MULTI });
    const args = evalDeps(files);
    files[SDK_PKG] = JSON.stringify({ name: "@catalyst-cloud/sdk", version: "0.7.0" });
    const v = linkOf(evaluateDepSkew(args), "installed-vs-locked");
    expect(v.status, "0.7.0 at the ROOT is skew even though 0.7.0 is locked for a NESTED key").toBe("skew");
    expect(v.detail).toContain("installed 0.7.0");
    expect(v.detail).toContain("0.8.2");
    expect(v.detail, "the detail must name the install location that was compared").toContain('"@catalyst-cloud/sdk"');
  });

  test("POSITIVE CONTROL — the SAME multi-version lockfile reports ok when the root install matches the root entry", () => {
    // Without this, the assertion above would also be satisfied by a comparator that had
    // simply started reporting skew for everything.
    expect(linkOf(evaluateDepSkew(evalDeps(fs({ [LOCK]: LOCK_TEXT_MULTI }))), "installed-vs-locked").status).toBe("ok");
  });

  test("an install path that cannot be associated with a lock entry is INCONCLUSIVE, and NAMES the elsewhere-versions without accepting them", () => {
    const files = fs({ [LOCK]: LOCK_TEXT_MULTI });
    const args = evalDeps(files);
    // A workspace-linked package: real on disk, outside node_modules, so its bun key is the
    // workspace's name and no path can supply it.
    const outside = `${ROOT}/packages/sdk/package.json`;
    files[outside] = JSON.stringify({ name: "@catalyst-cloud/sdk", version: "0.7.0" });
    args.breadcrumb = { ...args.breadcrumb, packages: args.breadcrumb.packages.map((p) => ({ ...p, packageJsonPath: outside })) };
    const v = linkOf(evaluateDepSkew(args), "installed-vs-locked");
    expect(v.status, "an unassociable path must not silently match some other resolution").toBe("inconclusive");
    expect(v.detail).toMatch(/could not be associated/i);
    expect(v.detail).toMatch(/locked elsewhere at 0\.7\.0, 0\.8\.2/);
  });
});

describe("depSkewFields (the heartbeat-carried alert surface)", () => {
  test("carries the mode, the verdict, and BOTH short digests — never a secret", () => {
    const f = depSkewFields({ mode: "shadow", bootLockHash: "sha256:0123456789abcdef", currentLockHash: "sha256:fedcba9876543210", skewed: true, sustained: true, wouldRestart: true });
    expect(f["catalyst.cloud_sync.deps.mode"]).toBe("shadow");
    expect(f["catalyst.cloud_sync.deps.skewed"]).toBe(true);
    expect(f["catalyst.cloud_sync.deps.would_restart"]).toBe(true);
    expect(f["catalyst.cloud_sync.deps.boot_lock_hash"]).toBe("0123456789ab");
    expect(f["catalyst.cloud_sync.deps.current_lock_hash"]).toBe("fedcba987654");
    expect(JSON.stringify(f)).not.toMatch(/token|secret|lin_|Bearer/i);
  });

  test("unknown inputs stay null (never a bogus false that reads as 'no skew')", () => {
    const f = depSkewFields({ mode: "shadow" });
    expect(f["catalyst.cloud_sync.deps.skewed"]).toBeNull();
    expect(f["catalyst.cloud_sync.deps.boot_lock_hash"]).toBeNull();
  });
});

describe("the self-heal exit reason", () => {
  test("dep-skew is a DISTINCT reason from the CTL-1508 stall, so the two paths stay separable", () => {
    expect(DEP_SKEW_REASON).toBe("dep-skew");
  });
});

// ─── the unified-log event (AC1: "the restart is visible in the event log") ─────────────
//
// The acceptance clause this covers was REFUTED on the first cut of this PR: the dep-skew
// restart wrote a pino line to stderr and nothing at all to ~/catalyst/events/YYYY-MM.jsonl,
// so `catalyst-events wait-for`, the broker, the HUD and orch-monitor could not observe the
// restart at all. The capability was present and simply unused — cloud-sync.mjs's
// `emitWriterIdleEvent` already appends a v2 envelope to that exact file.
describe("depSkewEventEnvelope (the unified event-log surface)", () => {
  const base = {
    host: "mini-2",
    mode: "enforce",
    reason: null,
    bootLockHash: "sha256:0123456789abcdef",
    currentLockHash: "sha256:fedcba9876543210",
    lockPath: "/opt/plugin-source/bun.lock",
    sustained: true,
    wouldRestart: true,
    ts: "2026-08-13T00:00:00Z",
    id: "deadbeefdeadbeef",
    traceId: "0".repeat(32),
    spanId: "1".repeat(16),
    resource: { "service.name": "catalyst.cloud-sync" },
  };

  test("is a V2 envelope — {ts, attributes, body, resource}, the shape catalyst-events reads", () => {
    // v1 is the bash `{ts, event, orchestrator, worker, detail}` shape; a v2 consumer keys on
    // attributes["event.name"], so an envelope missing `attributes` is an unreadable event.
    const e = depSkewEventEnvelope({ name: DEP_SKEW_RESTART_EVENT, ...base, restart: true });
    expect(e.ts).toBe("2026-08-13T00:00:00Z");
    expect(e.observedTs).toBe(e.ts);
    expect(e.resource).toEqual({ "service.name": "catalyst.cloud-sync" });
    expect(e.attributes["event.name"]).toBe(DEP_SKEW_RESTART_EVENT);
    expect(typeof e.body.message).toBe("string");
    expect(e.severityText).toBe("WARN");
    expect(e.severityNumber).toBe(13);
    // It must survive the transport it will actually take.
    expect(() => JSON.parse(JSON.stringify(e))).not.toThrow();
    expect(JSON.stringify(e)).not.toContain("\n"); // one event, one JSONL line
  });

  test("the acted restart and the held would-restart are DISTINCT names and distinct actions", () => {
    // Two names rather than one-name-plus-a-payload-field, because otel-forward strips
    // `body.payload` off-machine: an alert rule that has to reach into the payload to tell a
    // real restart from a shadow-mode observation cannot fire off-machine at all.
    expect(DEP_SKEW_RESTART_EVENT).not.toBe(DEP_SKEW_WOULD_RESTART_EVENT);
    const acted = depSkewEventEnvelope({ name: DEP_SKEW_RESTART_EVENT, ...base, restart: true });
    const held = depSkewEventEnvelope({ name: DEP_SKEW_WOULD_RESTART_EVENT, ...base, mode: "shadow", reason: "dep-skew mode is shadow — would restart, mutating nothing", restart: false });
    expect(acted.attributes["event.action"]).toBe("dep_skew_restart");
    expect(held.attributes["event.action"]).toBe("dep_skew_would_restart");
    expect(acted.attributes["catalyst.cloud_sync.deps.restart"]).toBe(true);
    expect(held.attributes["catalyst.cloud_sync.deps.restart"]).toBe(false);
    // The held event must NOT read as a restart in prose either — an operator scanning the
    // log body is the second reader of this line.
    expect(acted.body.message).toMatch(/restarting/i);
    expect(held.body.message).toMatch(/NOT restarting/i);
    expect(held.attributes["catalyst.cloud_sync.deps.reason"]).toMatch(/shadow/);
  });

  test("every load-bearing field rides ATTRIBUTES, because body.payload is stripped off-machine", () => {
    const e = depSkewEventEnvelope({ name: DEP_SKEW_RESTART_EVENT, ...base, restart: true });
    // Both digests, the mode, the sustained/would-restart verdict, the lockfile path and the
    // host must all be answerable from `attributes` alone.
    expect(e.attributes["catalyst.cloud_sync.deps.boot_lock_hash"]).toBe("0123456789ab");
    expect(e.attributes["catalyst.cloud_sync.deps.current_lock_hash"]).toBe("fedcba987654");
    expect(e.attributes["catalyst.cloud_sync.deps.mode"]).toBe("enforce");
    expect(e.attributes["catalyst.cloud_sync.deps.sustained"]).toBe(true);
    expect(e.attributes["catalyst.cloud_sync.deps.would_restart"]).toBe(true);
    expect(e.attributes["catalyst.cloud_sync.deps.lock_path"]).toBe("/opt/plugin-source/bun.lock");
    expect(e.attributes.host).toBe("mini-2");
    expect(e.attributes["event.label"]).toBe("mini-2");
    expect(e.body.payload).toBeUndefined();
  });

  test("the digest attributes come from depSkewFields, so the event and the heartbeat cannot drift", () => {
    // Not a tautology: it pins that the envelope REUSES the shared field builder rather than
    // hand-copying six key names that a later rename would silently split in two.
    const e = depSkewEventEnvelope({ name: DEP_SKEW_RESTART_EVENT, ...base, restart: true });
    const fields = depSkewFields({ mode: "enforce", bootLockHash: base.bootLockHash, currentLockHash: base.currentLockHash, skewed: true, sustained: true, wouldRestart: true });
    for (const [k, v] of Object.entries(fields)) expect(e.attributes[k], `attribute ${k}`).toEqual(v);
  });

  test("carries no secret-shaped substring (it lands in a world-readable log file)", () => {
    const e = depSkewEventEnvelope({ name: DEP_SKEW_RESTART_EVENT, ...base, restart: true });
    expect(JSON.stringify(e)).not.toMatch(/token|secret|lin_|Bearer|sk-/i);
  });

  test("an unknown lock path degrades the message instead of printing 'undefined'", () => {
    const e = depSkewEventEnvelope({ name: DEP_SKEW_RESTART_EVENT, ...base, lockPath: null, restart: true });
    expect(e.body.message).not.toMatch(/undefined|null/);
    expect(e.attributes["catalyst.cloud_sync.deps.lock_path"]).toBeNull();
  });

  test("the event names stay inside catalyst.replica.* — the family cloud-sync already owns", () => {
    // Sibling of catalyst.replica.writer_idle, and clear of every CTL-1142 broker-protected
    // prefix (`filter.`, `broker.daemon`, `session.heartbeat`, `phase.<slot>.<status>`).
    for (const n of [DEP_SKEW_RESTART_EVENT, DEP_SKEW_WOULD_RESTART_EVENT]) {
      expect(n).toMatch(/^catalyst\.replica\./);
      expect(n.startsWith("filter.")).toBe(false);
      expect(n.startsWith("broker.daemon")).toBe(false);
    }
  });
});


// ─── CTL-1931: link 3 — serving root ────────────────────────────────────────
//
// The other links are all SELF-REFERENTIAL: they compare the modules under whatever root
// the process loaded from against THAT root's lockfile. A writer running out of a
// different checkout entirely is internally consistent and grades clean on every one of
// them. This block is the negative control the ticket demands.
describe("evaluateDepSkew — link 3: serving root (CTL-1931)", () => {
  test("the writer is serving a configured checkout → ok", () => {
    expect(linkOf(evaluateDepSkew(evalDeps(fs())), "serving-root").status).toBe("ok");
  });

  // ⭐ THE NEGATIVE CONTROL THE TICKET REQUIRES: reconstruct CTL-1919. The laptop's writer
  // ran from the dev checkout — three schema versions stale, so the replica had no
  // `workflow_states` table and sat 5.5 h behind — and was found BY HAND while this
  // detector reported nothing.
  test("⭐ CTL-1919: a writer serving an UNCONFIGURED checkout → skew", () => {
    const r = evaluateDepSkew(evalDeps(fs(), {
      expectedRoots: ["/Users/ryan/catalyst/plugin-source"],
    }));
    const v = linkOf(r, "serving-root");
    expect(v.status).toBe("skew");
    expect(r.skew).toBe(true);
    expect(v.detail).toContain(ROOT);                              // where it IS serving
    expect(v.detail).toContain("/Users/ryan/catalyst/plugin-source"); // where it SHOULD
  });

  // ⛔ The point of the whole link, asserted directly: in that same CTL-1919 state every
  // other link still reads ok. Without this, a reader could reasonably assume one of the
  // existing links would have caught it eventually.
  test("⛔ and in that state EVERY OTHER LINK still reads ok — which is why this link exists", () => {
    const r = evaluateDepSkew(evalDeps(fs(), { expectedRoots: ["/somewhere/else"] }));
    for (const link of SKEW_LINKS.filter((l) => l !== "serving-root")) {
      expect(linkOf(r, link).status).toBe("ok");
    }
  });

  test("no expectations configured → INCONCLUSIVE, never ok and never skew", () => {
    for (const expectedRoots of [null, undefined, [], ["", "  "].slice(0, 1)]) {
      const v = linkOf(evaluateDepSkew(evalDeps(fs(), { expectedRoots })), "serving-root");
      expect(v.status).toBe("inconclusive");
    }
  });

  // ⚠️ `[].includes(x)` is false, so the naive implementation reports SKEW here — a false
  // alarm on every node with nothing configured. Inverting it to ok would be a check that
  // passes because it never looked. Pinning the third value keeps both mistakes out.
  test("⚠️ an empty expectation list is not a skew (the [].includes trap)", () => {
    expect(evaluateDepSkew(evalDeps(fs(), { expectedRoots: [] })).skew).toBe(false);
  });

  test("a boot record with no root → INCONCLUSIVE", () => {
    const args = evalDeps(fs());
    const v = linkOf(evaluateDepSkew({ ...args, breadcrumb: { ...args.breadcrumb, root: null } }), "serving-root");
    expect(v.status).toBe("inconclusive");
  });

  // Two spellings of one directory (a symlinked home, /System/Volumes/Data/...) must not
  // manufacture a skew. The fixture paths do not exist on disk, so realpath is injected.
  test("realpath-equal roots spelled differently are NOT a skew", () => {
    const v = linkOf(evaluateDepSkew(evalDeps(fs(), {
      expectedRoots: ["/System/Volumes/Data/opt/plugin-source"],
      realpath: (x) => x.replace("/System/Volumes/Data", ""),
    })), "serving-root");
    expect(v.status).toBe("ok");
  });

  test("a trailing slash is not a skew", () => {
    expect(linkOf(evaluateDepSkew(evalDeps(fs(), { expectedRoots: [`${ROOT}/`] })), "serving-root").status).toBe("ok");
  });

  // A throwing realpath must degrade to a literal comparison, not abort the evaluation —
  // this is the path every unit test above actually takes (the fixture roots are fictional).
  test("a throwing realpath falls back to the literal string", () => {
    const v = linkOf(evaluateDepSkew(evalDeps(fs(), {
      realpath: () => { throw new Error("ENOENT"); },
    })), "serving-root");
    expect(v.status).toBe("ok");
  });
});

// ─── CTL-1931: bun's isolated linker ────────────────────────────────────────
//
// The defect these cover: `installed-vs-locked` answered "could not compare" on ALL THREE
// hosts (laptop, mini, mini-2) from the day CTL-1659 shipped, because the writer resolves
// through bun's isolated linker and `resolve()` hands back the store REALPATH — a content
// address with no install location in it. So the one link that would have caught CTL-1919
// (a writer serving schema 0.1.12 against a 0.1.15 pin) was inert on every host.
//
// Every case below is paired: a red is only evidence when the SAME instrument is shown
// going green on the neighbouring input, and the association is proved by the symlink the
// resolver actually traversed rather than read out of the store directory's own name —
// which would be circular (the installed version IS the store name) and would grade every
// host clean forever.
const STORE = `${ROOT}/node_modules/.bun`;
const SCHEMA_STORE = (v) => `${STORE}/@catalyst-cloud+schema@${v}+a0473b45aab9bf33`;
const SCHEMA_PKG_DIR = (v) => `${SCHEMA_STORE(v)}/node_modules/@catalyst-cloud/schema`;
const SDK_STORE = `${STORE}/@catalyst-cloud+sdk@0.8.11+a0473b45aab9bf33`;

// A lockfile that pins schema 0.1.15 with NO chained key — the real shape measured in
// plugin-source/bun.lock on 2026-08-17 (745 keys, 48 of them chained; schema is not one).
const LOCK_TEXT_ISOLATED = `{
  "lockfileVersion": 1,
  "workspaces": {
    "": { "name": "catalyst", "dependencies": { "@catalyst-cloud/schema": "0.1.15" } },
    "plugins/dev/scripts/execution-core": { "name": "catalyst-execution-core", "dependencies": { "@catalyst-cloud/sdk": "0.8.11" } },
  },
  "packages": {
    "@catalyst-cloud/schema": ["@catalyst-cloud/schema@0.1.15", "", {}, "sha512-aaa=="],
    "@catalyst-cloud/sdk": ["@catalyst-cloud/sdk@0.8.11", "", {}, "sha512-bbb=="],
  }
}`;

// links — a symlink table as `realpath` sees it: the link path collapses to its target.
// Anything absent resolves to itself, which is what the real realpathSync does for a plain
// directory and what makes an unmatched candidate simply fail to equal the target.
const linkFs = (links) => ({
  realpath: (p) => links[p] ?? p,
  listDir: (d) => (d === STORE ? [`@catalyst-cloud+schema@0.1.15+a0473b45aab9bf33`, `@catalyst-cloud+schema@0.1.12+a0473b45aab9bf33`, `@catalyst-cloud+sdk@0.8.11+a0473b45aab9bf33`] : []),
});

describe("CTL-1931 — decoding what bun encodes in a store directory name", () => {
  test("the id is recovered; '+' in the name half is the scope separator", () => {
    expect(decodeBunStoreDir("@catalyst-cloud+sdk@0.8.11+a0473b45aab9bf33")).toMatchObject({ id: "@catalyst-cloud/sdk", version: "0.8.11" });
    expect(decodeBunStoreDir("pino@9.6.0")).toMatchObject({ id: "pino", version: "9.6.0" });
    expect(decodeBunStoreDir("@catalyst-cloud+read-model@0.1.1")).toMatchObject({ id: "@catalyst-cloud/read-model", version: "0.1.1" });
  });

  test("a name with no version segment is null, not a half-decoded guess", () => {
    expect(decodeBunStoreDir("@scope")).toBeNull();
    expect(decodeBunStoreDir("")).toBeNull();
    expect(decodeBunStoreDir(null)).toBeNull();
    // POSITIVE CONTROL on the same instrument.
    expect(decodeBunStoreDir("pino@9.6.0").id).toBe("pino");
  });

  test("splitBunStorePath rejects a path INSIDE the package, which would decode to a plausible id", () => {
    expect(splitBunStorePath(ROOT, SCHEMA_PKG_DIR("0.1.15"))).toMatchObject({ id: "@catalyst-cloud/schema" });
    expect(splitBunStorePath(ROOT, `${SCHEMA_PKG_DIR("0.1.15")}/dist`), "…/schema/dist is not the package directory").toBeNull();
    expect(splitBunStorePath(ROOT, `${ROOT}/node_modules/@catalyst-cloud/schema`), "a hoisted path is not a store path").toBeNull();
    expect(splitBunStorePath("/elsewhere", SCHEMA_PKG_DIR("0.1.15"))).toBeNull();
  });
});

describe("CTL-1931 — the lockfile's workspace directories", () => {
  test("every workspace dir is listed, including the root's empty key", () => {
    expect(workspaceDirsFromLock(LOCK_TEXT_ISOLATED)).toContain("plugins/dev/scripts/execution-core");
    expect(workspaceDirsFromLock("{}"), "no workspaces block → no dirs, not a throw").toEqual([]);
    expect(workspaceDirsFromLock(null)).toEqual([]);
  });

  test("keys NESTED inside a workspace's own object are not mistaken for directories", () => {
    // "dependencies" / "@catalyst-cloud/sdk" sit one level deeper and must not be read as
    // workspace paths — the walk that produced them would send the importer search to
    // `<root>/dependencies/node_modules/...`, a directory that cannot exist.
    const dirs = workspaceDirsFromLock(LOCK_TEXT_ISOLATED);
    expect(dirs).not.toContain("dependencies");
    expect(dirs).not.toContain("@catalyst-cloud/sdk");
    expect(dirs).not.toContain("name");
  });
});

describe("CTL-1931 — the install location is recovered by PROOF, not by pattern", () => {
  const args = (over = {}) => ({ root: ROOT, id: "@catalyst-cloud/schema", lockText: LOCK_TEXT_ISOLATED, ...over });

  test("a package linked from the ROOT keys on the bare id", () => {
    const io = linkFs({ [`${ROOT}/node_modules/@catalyst-cloud/schema`]: SCHEMA_PKG_DIR("0.1.15") });
    expect(provenLockKey(args({ packageDir: SCHEMA_PKG_DIR("0.1.15"), ...io }))).toBe("@catalyst-cloud/schema");
  });

  test("a package linked from a WORKSPACE is found — the case this fleet actually runs", () => {
    // Measured 2026-08-17: @catalyst-cloud/sdk is absent from plugin-source's own
    // node_modules and linked ONLY from plugins/dev/scripts/execution-core, so a search
    // that checked the root alone would return null for the fleet's primary dependency.
    const io = linkFs({ [`${ROOT}/plugins/dev/scripts/execution-core/node_modules/@catalyst-cloud/sdk`]: `${SDK_STORE}/node_modules/@catalyst-cloud/sdk` });
    expect(provenLockKey(args({ id: "@catalyst-cloud/sdk", packageDir: `${SDK_STORE}/node_modules/@catalyst-cloud/sdk`, ...io }))).toBe("@catalyst-cloud/sdk");
  });

  test("⛔ THE CTL-1919 SHAPE — the SDK's OWN stale copy is caught while the root links a healthy one", () => {
    // The root links the PINNED 0.1.15 and looks perfectly healthy. The SDK links 0.1.12,
    // and the SDK's copy is the one that decides whether the writer knows about
    // `workflow_states`. A search that stopped at the first healthy link would clear this.
    const io = linkFs({
      [`${ROOT}/node_modules/@catalyst-cloud/schema`]: SCHEMA_PKG_DIR("0.1.15"),
      [`${SDK_STORE}/node_modules/@catalyst-cloud/schema`]: SCHEMA_PKG_DIR("0.1.12"),
    });
    const key = provenLockKey(args({ packageDir: SCHEMA_PKG_DIR("0.1.12"), ...io }));
    expect(key, "the STALE copy still resolves to the location the lockfile pins").toBe("@catalyst-cloud/schema");
    expect(lockedVersionForKey(LOCK_TEXT_ISOLATED, key, "@catalyst-cloud/schema").version, "…and that location pins 0.1.15, so 0.1.12 is drift").toBe("0.1.15");
  });

  test("BRANCH CONTROL — with the store scan disabled the SAME input is null, so the scan is load-bearing", () => {
    // Without this, the assertion above would also pass if the ROOT link had matched by
    // accident: both spellings of the key are identical, so the key alone cannot tell the
    // two branches apart.
    const io = linkFs({
      [`${ROOT}/node_modules/@catalyst-cloud/schema`]: SCHEMA_PKG_DIR("0.1.15"),
      [`${SDK_STORE}/node_modules/@catalyst-cloud/schema`]: SCHEMA_PKG_DIR("0.1.12"),
    });
    expect(provenLockKey(args({ packageDir: SCHEMA_PKG_DIR("0.1.12"), ...io, listDir: () => [] }))).toBeNull();
  });

  test("nothing links it → null → INCONCLUSIVE, never a version read off the store name", () => {
    const io = linkFs({});
    expect(provenLockKey(args({ packageDir: SCHEMA_PKG_DIR("0.1.12"), ...io }))).toBeNull();
    // POSITIVE CONTROL: the same call with the link present does resolve, so the null above
    // is a measurement rather than a function that only ever returns null.
    const linked = linkFs({ [`${ROOT}/node_modules/@catalyst-cloud/schema`]: SCHEMA_PKG_DIR("0.1.12") });
    expect(provenLockKey(args({ packageDir: SCHEMA_PKG_DIR("0.1.12"), ...linked }))).toBe("@catalyst-cloud/schema");
  });

  test("lockLocationKeyFor prefers the structural ladder and falls back to the proof", () => {
    // A classic hoisted layout still answers without touching the filesystem — proved by
    // passing a realpath that would THROW if it were consulted.
    const boom = () => {
      throw new Error("realpath must not be consulted for a structural path");
    };
    expect(lockLocationKeyFor({ root: ROOT, packageJsonPath: SDK_PKG, id: "@catalyst-cloud/sdk", realpath: boom, listDir: boom })).toBe("@catalyst-cloud/sdk");
    const io = linkFs({ [`${ROOT}/node_modules/@catalyst-cloud/schema`]: SCHEMA_PKG_DIR("0.1.15") });
    expect(lockLocationKeyFor({ root: ROOT, packageJsonPath: `${SCHEMA_PKG_DIR("0.1.15")}/package.json`, id: "@catalyst-cloud/schema", lockText: LOCK_TEXT_ISOLATED, ...io })).toBe("@catalyst-cloud/schema");
  });
});

describe("CTL-1931 — installed-vs-locked reaches a VERDICT on an isolated-linker host", () => {
  // The full comparator, driven the way doctor drives it, on the layout every host runs.
  const SCHEMA_ENTRY = (v) => `${SCHEMA_PKG_DIR(v)}/src/index.ts`;
  const bootFor = (v) => ({
    ts: NOW,
    pid: 4242,
    root: ROOT,
    lockPath: LOCK,
    lockHash: "sha256:deadbeef",
    degraded: false,
    degradedReasons: [],
    packages: [{ id: "@catalyst-cloud/schema", specifier: "@catalyst-cloud/schema", resolvedPath: SCHEMA_ENTRY(v), packageJsonPath: `${SCHEMA_PKG_DIR(v)}/package.json`, version: v, entryHash: null }],
  });
  const gradeArgs = (v, over = {}) => {
    const files = {
      [LOCK]: LOCK_TEXT_ISOLATED,
      [`${SCHEMA_PKG_DIR(v)}/package.json`]: JSON.stringify({ name: "@catalyst-cloud/schema", version: v }),
    };
    return {
      breadcrumb: bootFor(v),
      readText: (p) => {
        if (!Object.prototype.hasOwnProperty.call(files, p)) throw new Error(`ENOENT ${p}`);
        return files[p];
      },
      readJson: (p) => {
        if (!Object.prototype.hasOwnProperty.call(files, p)) throw new Error(`ENOENT ${p}`);
        return JSON.parse(files[p]);
      },
      processCommandForPid: (pid) => (pid === 4242 ? "bun /opt/plugin-source/plugins/dev/scripts/execution-core/cloud-sync.mjs" : null),
      expectedRoots: [ROOT],
      ...linkFs({ [`${ROOT}/node_modules/@catalyst-cloud/schema`]: SCHEMA_PKG_DIR(v) }),
      ...over,
    };
  };

  test("⭐ the pinned install grades ok — where it used to say 'could not compare'", () => {
    expect(linkOf(evaluateDepSkew(gradeArgs("0.1.15")), "installed-vs-locked").status).toBe("ok");
  });

  test("⛔ NEGATIVE CONTROL — the CTL-1919 install (0.1.12 against a 0.1.15 pin) grades SKEW", () => {
    const v = linkOf(evaluateDepSkew(gradeArgs("0.1.12")), "installed-vs-locked");
    expect(v.status, "a genuinely stale install must still report MISMATCH").toBe("skew");
    expect(v.detail).toContain("installed 0.1.12");
    expect(v.detail).toContain("0.1.15");
  });

  test("the three-valued contract holds — an unprovable association is INCONCLUSIVE, never ok", () => {
    // Same stale install, but nothing on disk links it: the comparator must not fall back
    // to the permissive any-occurrence match that would find 0.1.12 elsewhere in the file.
    const v = linkOf(evaluateDepSkew(gradeArgs("0.1.12", { realpath: (p) => p, listDir: () => [] })), "installed-vs-locked");
    expect(v.status).toBe("inconclusive");
    expect(v.detail).toMatch(/could not be associated/i);
  });
});

describe("CTL-1931 — CRITICAL_DEPS covers the package that CAUSED CTL-1919", () => {
  test("@catalyst-cloud/schema is recorded, resolved through the SDK that loads it", () => {
    const schema = CRITICAL_DEPS.find((d) => d.id === "@catalyst-cloud/schema");
    expect(schema, "the schema version is what decides whether the replica has workflow_states").toBeTruthy();
    expect(schema.from, "the copy that matters is the SDK's, not a separate one the root may link").toBe("@catalyst-cloud/sdk/node");
    // Ordering is load-bearing: `from` reads a resolution recorded EARLIER in the same pass.
    expect(CRITICAL_DEPS.findIndex((d) => d.specifier === schema.from)).toBeLessThan(CRITICAL_DEPS.findIndex((d) => d.id === schema.id));
  });

  test("a `from` dep resolves from its base's location, not the daemon's", () => {
    const SDK_DIR = `${SDK_STORE}/node_modules/@catalyst-cloud/sdk`;
    const bases = [];
    const record = captureLoadedDeps(
      deps(
        {
          [LOCK]: LOCK_TEXT_ISOLATED,
          [`${SDK_DIR}/dist/node.js`]: "// sdk\n",
          [`${SDK_DIR}/package.json`]: JSON.stringify({ name: "@catalyst-cloud/sdk", version: "0.8.11" }),
          [`${SCHEMA_PKG_DIR("0.1.12")}/src/index.ts`]: "// schema\n",
          [`${SCHEMA_PKG_DIR("0.1.12")}/package.json`]: JSON.stringify({ name: "@catalyst-cloud/schema", version: "0.1.12" }),
        },
        {
          deps: CRITICAL_DEPS,
          resolveModule: (spec, opts) => {
            bases.push(opts?.fromPath ?? null);
            if (spec === "@catalyst-cloud/sdk/node") return `${SDK_DIR}/dist/node.js`;
            if (spec === "@catalyst-cloud/schema") return `${SCHEMA_PKG_DIR("0.1.12")}/src/index.ts`;
            throw new Error(`Cannot find module '${spec}'`);
          },
        },
      ),
    );
    expect(bases[0], "the SDK itself resolves from the daemon").toBeNull();
    expect(bases[1], "the schema resolves from the SDK's resolved path").toBe(`${SDK_DIR}/dist/node.js`);
    expect(record.packages.map((p) => `${p.id}@${p.version}`)).toEqual(["@catalyst-cloud/sdk@0.8.11", "@catalyst-cloud/schema@0.1.12"]);
  });

  test("a `from` whose base did NOT resolve is degraded, never re-based onto the daemon", () => {
    // Silently falling back to the daemon's own resolution would record a DIFFERENT copy
    // than the writer runs — the substitution the field exists to prevent.
    const record = captureLoadedDeps(
      deps(
        {},
        {
          deps: CRITICAL_DEPS,
          resolveModule: (spec) => {
            if (spec === "@catalyst-cloud/schema") return `${SCHEMA_PKG_DIR("0.1.12")}/src/index.ts`;
            throw new Error(`Cannot find module '${spec}'`);
          },
        },
      ),
    );
    expect(record.degraded).toBe(true);
    expect(record.degradedReasons.join(" ")).toMatch(/base dependency @catalyst-cloud\/sdk\/node did not resolve/);
    expect(record.packages.some((p) => p.id === "@catalyst-cloud/schema"), "the dependent is SKIPPED, not recorded against the wrong base").toBe(false);
  });
});
