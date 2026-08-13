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
  captureLoadedDeps,
  classifyRestartBudget,
  depSkewEventEnvelope,
  depSkewFields,
  evaluateDepSkew,
  findLockRoot,
  lockedVersionsFor,
  readDepsBreadcrumb,
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
