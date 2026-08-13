// cloud-sync-deps.mjs — CTL-1659. The loaded-dependency identity record for the
// supervised catalyst-cloud-sync writer, plus the three-link skew comparator doctor
// grades it with and the durable restart budget that bounds the self-heal loop.
//
// THE DEFECT. `plugin-refresh` emits `restart_needed` on daemon skew and deliberately
// stops there ("restart stays a gated OPERATOR action — never automated here"), and the
// broker's `decideStackReload` hard-codes exactly three components (monitor,
// execution-core, otel-forward) — cloud-sync is in NEITHER. So on 2026-08-04 a dependency
// fix landed on main, the updater pulled it, the install succeeded, and the RUNNING
// cloud-sync daemon kept serving the OLD modules indefinitely: the CTC-328
// delete-corruption guard sat correctly installed on both minis while the writers ran
// unguarded, until a human kickstarted them. Nothing alerted. This is the same class as
// CTL-1506's missing otel-forward entry — "a merged fix that never restarts is
// indistinguishable from no fix" — one link further down the chain.
//
// WHY THE EVIDENCE IS A HASH OF WHAT WAS RESOLVED, NOT A CLAIM ABOUT IT. The trap this
// module exists to avoid is the one that made the incident invisible in the first place:
// `applied == installed` passes vacuously because BOTH go stale together. The
// loaded-vs-locked analogue is a daemon that writes "I loaded what the lockfile said" at
// boot — that re-manufactures the same lie (the CTL-1646 shadowed-install class). So the
// boot record carries what the process ACTUALLY resolved: `createRequire(...).resolve()`'s
// absolute path, the version read from THAT path's package.json, a digest of the resolved
// entry file, the root the module was served from, and a SHA-256 of that root's lockfile.
// Versions alone are permanently non-discriminating — a repointed tarball, a workspace
// link, or a git dep ships new bytes under the same semver — so the VERDICT keys on the
// digest and the versions ride along only because the alert has to name them.
//
// EVERY READER IS FAIL-CLOSED. A missing/unreadable/malformed input yields
// `inconclusive`, never `ok`: an absent breadcrumb, a dead-or-recycled pid, an
// unreadable lockfile, and an EMPTY package list ([].every(p) === true) must each be
// unable to produce a clean bill of health. That is the property `restart_needed` lacked.
//
// Zero imports beyond node builtins (crypto/fs/path), so `catalyst doctor`'s bare-Node
// runtime loads it without dragging in the bun:sqlite graph — the same constraint
// doctor.mjs's other leaf imports honor.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// The packages whose loaded identity is recorded. A REGISTRY rather than an inline
// literal so a second critical dep is a one-line addition — and so `captureLoadedDeps`
// can assert it is non-empty (an empty list would make every comparison vacuously clean,
// which is the exact defect shape this module is built against).
//
// `specifier` is what cloud-sync.mjs actually imports (`@catalyst-cloud/sdk/node`), so
// the resolve below follows the SAME export map the running daemon followed; `id` is the
// package name used to look the resolution up in the lockfile.
export const CRITICAL_DEPS = [
  { id: "@catalyst-cloud/sdk", specifier: "@catalyst-cloud/sdk/node" },
];

// The discriminator stamped into the CTL-1508 self-heal breadcrumb when the writer exits
// for dep-skew rather than for a stall. Both paths share one exit mechanism (breadcrumb +
// bounded `exitAfterClose(exitCode: 1)`) — deliberately, so health-responder.sh's
// `no-respawn` net covers this exit too with no change — and this field is what keeps the
// two separable in an RCA.
export const DEP_SKEW_REASON = "dep-skew";

// The dep-skew alert name carried on the heartbeat line (and the field a Grafana rule
// keys on). Shadow-with-nobody-watching is the failure being fixed, so the skew fields
// ride the daemon's existing stderr→cloud-sync.log→Alloy→Loki path from day one.
export const DEP_SKEW_ALERT = "replica_dep_skew";

// ─── hashing + root discovery ───────────────────────────────────────────────

// sha256File — content digest of a file, prefixed with the algorithm so a future
// algorithm change is visible in the record rather than silently comparing apples to
// pears. Unreadable → null (NEVER a fabricated digest a comparison could pass on: the
// comparators treat a null on either side as inconclusive).
export function sha256File(path, { readText = (p) => readFileSync(p, "utf8") } = {}) {
  try {
    return `sha256:${createHash("sha256").update(readText(path)).digest("hex")}`;
  } catch {
    return null;
  }
}

// findLockRoot — walk up from `startDir` to the first directory holding a `bun.lock`.
// This is the root that ACTUALLY served the module, which matters because the daemons run
// from ~/catalyst/plugin-source, not from an operator's dev checkout: a doctor that
// compared against its own cwd's lockfile would be comparing the wrong root entirely.
// Returns null (not a guessed root) when there is no lockfile above the start.
export function findLockRoot(startDir, { fileExists = existsSync } = {}) {
  let dir = startDir;
  while (typeof dir === "string" && dir.length > 0) {
    const lockPath = join(dir, "bun.lock");
    try {
      if (fileExists(lockPath)) return { root: dir, lockPath };
    } catch {
      return null; // an exploding fileExists must not spin the walk
    }
    const parent = dirname(dir);
    if (parent === dir) return null; // reached the filesystem root
    dir = parent;
  }
  return null;
}

// findPackageJson — walk up from a resolved entry file to the package.json that OWNS it
// (name === id). Walking to the first package.json is not enough: a package can ship a
// nested `dist/package.json` (`{"type":"module"}` is a common one), and reading a version
// out of that would silently record `undefined`.
function findPackageJson(startDir, id, { fileExists, readJson }) {
  let dir = startDir;
  while (typeof dir === "string" && dir.length > 0) {
    const candidate = join(dir, "package.json");
    try {
      if (fileExists(candidate)) {
        const parsed = readJson(candidate);
        if (parsed && parsed.name === id) return { path: candidate, version: parsed.version ?? null };
      }
    } catch {
      /* unreadable/malformed → keep walking; a null result is handled by the caller */
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

// ─── boot capture ───────────────────────────────────────────────────────────

// captureLoadedDeps — build the boot record. Called ONCE, right after the writer reaches
// 'live', from the process whose module identity it describes; every failure is recorded
// as a named `degradedReason` and flips `degraded` rather than being swallowed, so a
// record that could not measure what it claims to measure can never read as clean.
export function captureLoadedDeps({
  startDir,
  deps = CRITICAL_DEPS,
  resolveModule,
  fileExists = existsSync,
  readText = (p) => readFileSync(p, "utf8"),
  readJson = (p) => JSON.parse(readFileSync(p, "utf8")),
  pid = process.pid,
  now = Date.now,
} = {}) {
  const degradedReasons = [];
  const packages = [];

  // The vacuous-loop guard, stated first because everything below iterates this list:
  // a zero-length registry would make every downstream comparison trivially "clean".
  if (!Array.isArray(deps) || deps.length === 0) {
    degradedReasons.push("no critical dependencies configured — nothing to compare");
  }

  for (const dep of Array.isArray(deps) ? deps : []) {
    const id = dep?.id;
    const specifier = dep?.specifier ?? id;
    let resolvedPath = null;
    try {
      resolvedPath = resolveModule(specifier);
    } catch (err) {
      degradedReasons.push(`${id}: unresolvable (${err?.message ?? String(err)})`);
      continue;
    }
    if (typeof resolvedPath !== "string" || resolvedPath.length === 0) {
      degradedReasons.push(`${id}: resolver returned no path`);
      continue;
    }
    const owner = findPackageJson(dirname(resolvedPath), id, { fileExists, readJson });
    if (!owner) degradedReasons.push(`${id}: no owning package.json above ${resolvedPath}`);
    const entryHash = sha256File(resolvedPath, { readText });
    if (entryHash === null) degradedReasons.push(`${id}: entry file unreadable (${resolvedPath})`);
    packages.push({
      id,
      specifier,
      resolvedPath,
      packageJsonPath: owner?.path ?? null,
      version: owner?.version ?? null,
      entryHash,
    });
  }

  // The root is derived from the FIRST successfully resolved module — the root that
  // actually served the bytes — and only falls back to the daemon's own directory when
  // nothing resolved at all (in which case the record is already degraded).
  const walkFrom = packages.find((p) => p.resolvedPath)?.resolvedPath;
  const found =
    (walkFrom ? findLockRoot(dirname(walkFrom), { fileExists }) : null) ??
    (startDir ? findLockRoot(startDir, { fileExists }) : null);
  if (!found) degradedReasons.push("no bun.lock found above the loaded modules — cannot anchor a lockfile digest");
  const lockHash = found ? sha256File(found.lockPath, { readText }) : null;
  if (found && lockHash === null) degradedReasons.push(`lockfile unreadable (${found.lockPath})`);

  return {
    ts: typeof now === "function" ? now() : now,
    pid,
    root: found?.root ?? null,
    lockPath: found?.lockPath ?? null,
    lockHash,
    degraded: degradedReasons.length > 0,
    degradedReasons,
    packages,
  };
}

// ─── breadcrumb io (atomic; fail-open) ──────────────────────────────────────
// Read from ANOTHER process (doctor), so the write is tmp+rename — the same
// writeSelfHealBreadcrumb idiom — and a torn read is structurally impossible.

export function writeDepsBreadcrumb(path, record, { writeFile = writeFileSync, rename = renameSync } = {}) {
  try {
    const tmp = `${path}.tmp`;
    writeFile(tmp, JSON.stringify(record));
    rename(tmp, path);
    return true;
  } catch {
    return false; // fail-open — recording module identity must never block the writer's boot
  }
}

export function readDepsBreadcrumb(path, { readText = (p) => readFileSync(p, "utf8") } = {}) {
  try {
    const parsed = JSON.parse(readText(path));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null; // absent (the pre-rollout normal case) or malformed — both read as "unknown"
  }
}

// ─── lockfile resolution lookup ─────────────────────────────────────────────

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// lockedVersionsFor — every version bun's lockfile resolves for `id`, hoisted or nested.
// bun.lock is JSONC (trailing commas), so `JSON.parse` is not available; the `packages`
// map's entry shape is stable and unambiguous instead:
//     "<key>": ["<name>@<version>", "<resolution>", {…}, "<integrity>"]
// where `<key>` is the package id for a hoisted resolution and `<parent>/<id>` for a
// nested one. Anchoring on BOTH the key's final segment and the value's `name@` prefix is
// what keeps this a structured match rather than the substring grep that has produced
// false clean results here before.
//
// Returns a three-valued verdict: a package with no entry is INCONCLUSIVE ("I could not
// look"), never an implicit "no skew".
export function lockedVersionsFor(lockText, id) {
  if (typeof lockText !== "string" || lockText.length === 0) {
    return { conclusive: false, versions: [], reason: "lockfile text unavailable" };
  }
  const e = escapeRe(id);
  const re = new RegExp(`"(?:[^"]*/)?${e}"\\s*:\\s*\\[\\s*"${e}@([^"]+)"`, "g");
  const versions = [...new Set([...lockText.matchAll(re)].map((m) => m[1]))].sort();
  if (versions.length === 0) {
    return { conclusive: false, versions: [], reason: `${id} not found in the lockfile's packages map` };
  }
  return { conclusive: true, versions, reason: null };
}

// lockKeyForPackageJsonPath — bun's `packages` map is keyed by the INSTALL LOCATION, not by
// the bare package name: a hoisted resolution is keyed `<id>` and a nested one
// `<parent>/<id>`, with deeper nesting chaining the parents (`a/b/x`; measured in this
// repo's own bun.lock as `@babel/core/semver`, `@eslint/eslintrc/ajv`, …). That key is
// precisely the association `lockedVersionsFor` throws away, and throwing it away is a
// fail-open: `versions.includes(installed)` accepts ANY resolution anywhere in the file, so
// a ROOT install stranded at 0.7.0 while the root entry locks 0.8.2 reports "ok" on the
// strength of some unrelated NESTED 0.7.0 — hiding the shadowed/partial install that is the
// entire reason the installed-vs-locked link exists.
//
// Derived STRUCTURALLY from the recorded package directory relative to the serving root:
// every hop must be a literal `node_modules` segment followed by a package name (two path
// segments when the name is scoped). Anything that does not fit that shape returns null —
// a path outside the recorded root, or a workspace package linked in from outside
// `node_modules` (whose bun key is the WORKSPACE's package name, which the path alone
// cannot supply). The caller renders a null key as INCONCLUSIVE and never falls back to the
// permissive any-occurrence match: "I could not associate it" must not read as "it matches".
export function lockKeyForPackageJsonPath(root, packageJsonPath) {
  if (typeof root !== "string" || root.length === 0) return null;
  if (typeof packageJsonPath !== "string" || packageJsonPath.length === 0) return null;
  const dir = dirname(packageJsonPath);
  const prefix = root.endsWith("/") ? root : `${root}/`;
  if (!dir.startsWith(prefix)) return null;
  const segs = dir.slice(prefix.length).split("/").filter((s) => s.length > 0);
  const chain = [];
  let i = 0;
  while (i < segs.length) {
    if (segs[i] !== "node_modules") return null;
    i += 1;
    if (i >= segs.length) return null;
    let name = segs[i];
    i += 1;
    if (name.startsWith("@")) {
      if (i >= segs.length) return null; // a scope with no package after it is not a package dir
      name = `${name}/${segs[i]}`;
      i += 1;
    }
    chain.push(name);
  }
  return chain.length > 0 ? chain.join("/") : null;
}

// lockedVersionForKey — the ONE resolution bun records at a specific install location.
// Anchored on the exact key AND the value's `name@` prefix (the same structured-match
// discipline `lockedVersionsFor` uses, minus the `(?:[^"]*/)?` wildcard that made it accept
// every nesting). Three-valued: a key with no entry is INCONCLUSIVE, never "no drift".
export function lockedVersionForKey(lockText, key, id) {
  if (typeof lockText !== "string" || lockText.length === 0) {
    return { conclusive: false, version: null, reason: "lockfile text unavailable" };
  }
  if (typeof key !== "string" || key.length === 0) {
    return {
      conclusive: false,
      version: null,
      reason: "the installed path could not be associated with a lockfile install location (outside the serving root, or a workspace link)",
    };
  }
  const m = new RegExp(`"${escapeRe(key)}"\\s*:\\s*\\[\\s*"${escapeRe(id)}@([^"]+)"`).exec(lockText);
  if (!m) return { conclusive: false, version: null, reason: `no "${key}" entry in the lockfile's packages map` };
  return { conclusive: true, version: m[1], reason: null };
}

// ─── the three-link comparator ──────────────────────────────────────────────
//
// Each link answers a question the others cannot, and each fails closed:
//   record-identity      — does the boot record describe the process running RIGHT NOW?
//                          A dead or RECYCLED pid makes links 2–4 stale evidence, so an
//                          identity failure short-circuits them to inconclusive rather
//                          than letting a fresh-looking file grade the wrong process.
//   boot-record-complete — did the capture measure everything it claims to?
//   loaded-vs-locked     — has the root lockfile changed since the daemon loaded its
//                          modules? THIS is the CTL-1659 incident: installed-but-unloaded.
//   installed-vs-locked  — does node_modules on disk match the lockfile's resolution? This
//                          catches what a restart does NOT fix (the partial install from
//                          the 180s SIGKILL ceiling, and the CTL-1646 shadowed install).

export const SKEW_LINKS = ["record-identity", "boot-record-complete", "loaded-vs-locked", "installed-vs-locked"];

const ok = (link, detail) => ({ link, status: "ok", detail });
const skew = (link, detail) => ({ link, status: "skew", detail });
const unknown = (link, detail) => ({ link, status: "inconclusive", detail });

function summarize(verdicts) {
  return {
    verdicts,
    skew: verdicts.some((v) => v.status === "skew"),
    inconclusive: verdicts.some((v) => v.status === "inconclusive"),
  };
}

export function evaluateDepSkew({
  breadcrumb = null,
  readText = (p) => readFileSync(p, "utf8"),
  readJson = (p) => JSON.parse(readFileSync(p, "utf8")),
  processCommandForPid = () => null,
  writerPattern = "cloud-sync.mjs",
} = {}) {
  if (!breadcrumb || typeof breadcrumb !== "object") {
    return summarize(SKEW_LINKS.map((l) => unknown(l, "no boot record — the writer has not booted since dep-skew capture shipped, or the write failed")));
  }

  // Link 1 — identity, evaluated FIRST because it licenses the other three.
  const pid = Number(breadcrumb.pid);
  let cmd = null;
  try {
    cmd = Number.isInteger(pid) && pid > 0 ? processCommandForPid(pid) : null;
  } catch {
    cmd = null;
  }
  const identityOk = typeof cmd === "string" && cmd.includes(writerPattern);
  if (!identityOk) {
    const why =
      !Number.isInteger(pid) || pid <= 0
        ? "boot record carries no usable pid"
        : cmd == null
          ? `boot record pid ${pid} is not running`
          : `boot record pid ${pid} has been recycled onto another program`;
    // Stale evidence: report the remaining links as inconclusive rather than grading a
    // fresh-looking file against the wrong process (fail-closed, the recycled-pid
    // discipline catalyst-monitor.sh already applies to its pid files).
    return summarize([
      unknown("record-identity", `${why} — the boot record is stale evidence; skew is UNKNOWN`),
      ...SKEW_LINKS.slice(1).map((l) => unknown(l, "not evaluated — the boot record does not describe the live writer")),
    ]);
  }
  const verdicts = [ok("record-identity", `boot record describes the live writer (pid ${pid})`)];

  // Link 2 — completeness of the capture itself.
  verdicts.push(
    breadcrumb.degraded
      ? unknown("boot-record-complete", `boot record is degraded: ${(breadcrumb.degradedReasons ?? []).join("; ") || "reason not recorded"}`)
      : ok("boot-record-complete", `${(breadcrumb.packages ?? []).length} package(s) recorded at boot`),
  );

  const packages = Array.isArray(breadcrumb.packages) ? breadcrumb.packages : [];

  // Link 3 — loaded vs locked (the incident). TWO independent digests, both required, and
  // a drift in EITHER is skew:
  //   (a) the ROOT LOCKFILE's digest — did the resolution graph change since boot?
  //   (b) each package's ENTRY-FILE digest — did the bytes the process actually loaded
  //       change on disk since boot?
  //
  // (b) is not redundant with (a). `captureLoadedDeps` records `entryHash` expressly as the
  // discriminator — this module's own header says "the VERDICT keys on the digest and the
  // versions ride along only because the alert has to name them" — and until now NO
  // comparator read it back. A repointed mutable artifact, a `bun link`ed workspace output,
  // or an in-place rebuild changes the bytes the running process holds while the lockfile
  // TEXT and the package version stay byte-identical: (a) alone reports ok, doctor PASSes,
  // and the writer never restarts although it is serving pre-change code. A field captured
  // as the discriminator and never compared is "a check that cannot fail" — the same defect
  // class as `restart_needed`, one level further in.
  //
  // Fail-closed on both halves: an unknown digest on either side is INCONCLUSIVE (never
  // ok), and ZERO recorded packages is inconclusive too — a loop that never ran is not a
  // clean bill of health ([].every(p) === true is the trap this file is built against).
  const lockPath = breadcrumb.lockPath;
  const bootLockHash = breadcrumb.lockHash;
  let lockText = null;
  try {
    lockText = typeof lockPath === "string" && lockPath.length > 0 ? readText(lockPath) : null;
  } catch {
    lockText = null;
  }
  const currentLockHash = lockText === null ? null : sha256File(lockPath, { readText: () => lockText });
  const loadedDrifts = [];
  const loadedUnknowns = [];
  if (typeof bootLockHash !== "string" || bootLockHash.length === 0) {
    loadedUnknowns.push("boot record carries no lockfile digest — nothing to compare against");
  } else if (currentLockHash === null) {
    loadedUnknowns.push(`lockfile ${lockPath} is unreadable now — skew is UNKNOWN, not absent`);
  } else if (currentLockHash !== bootLockHash) {
    loadedDrifts.push(`the root lockfile changed since the writer loaded its modules (boot ${short(bootLockHash)} → now ${short(currentLockHash)}, ${lockPath})`);
  }
  if (packages.length === 0) {
    loadedUnknowns.push("no package identities recorded at boot — zero entry-digest comparisons is not a clean result");
  }
  for (const p of packages) {
    const id = p?.id ?? "(unnamed package)";
    if (typeof p?.entryHash !== "string" || p.entryHash.length === 0) {
      loadedUnknowns.push(`${id}: no entry digest recorded at boot — the loaded bytes cannot be compared`);
      continue;
    }
    if (typeof p?.resolvedPath !== "string" || p.resolvedPath.length === 0) {
      loadedUnknowns.push(`${id}: no resolved entry path recorded at boot`);
      continue;
    }
    const currentEntryHash = sha256File(p.resolvedPath, { readText });
    if (currentEntryHash === null) {
      loadedUnknowns.push(`${id}: entry file ${p.resolvedPath} is unreadable now — the loaded bytes are UNKNOWN, not unchanged`);
      continue;
    }
    if (currentEntryHash !== p.entryHash) {
      loadedDrifts.push(`${id} entry bytes changed on disk since the writer loaded them (boot ${short(p.entryHash)} → now ${short(currentEntryHash)}, ${p.resolvedPath})`);
    }
  }
  if (loadedDrifts.length > 0) {
    verdicts.push(
      skew(
        "loaded-vs-locked",
        `${loadedDrifts.join("; ")} — the daemon is serving pre-change modules; restart it (launchctl kickstart -k) to load the installed fix`,
      ),
    );
  } else if (loadedUnknowns.length > 0) {
    verdicts.push(unknown("loaded-vs-locked", `could not compare: ${loadedUnknowns.join("; ")}`));
  } else {
    verdicts.push(
      ok("loaded-vs-locked", `loaded modules match the current lockfile (${short(bootLockHash)}) and all ${packages.length} entry digest(s) are unchanged on disk`),
    );
  }

  // Link 4 — installed vs locked (what a restart does NOT fix).
  if (packages.length === 0) {
    verdicts.push(unknown("installed-vs-locked", "no package identities recorded at boot — zero comparisons is not a clean result"));
  } else {
    const root = typeof breadcrumb.root === "string" ? breadcrumb.root : null;
    const drifts = [];
    const unknowns = [];
    for (const p of packages) {
      let installed = null;
      try {
        installed = typeof p.packageJsonPath === "string" ? readJson(p.packageJsonPath)?.version ?? null : null;
      } catch {
        installed = null;
      }
      if (installed == null) {
        unknowns.push(`${p.id}: installed package.json unreadable (${p.packageJsonPath ?? "path not recorded"})`);
        continue;
      }
      if (lockText === null) {
        unknowns.push(`${p.id}: lockfile unreadable`);
        continue;
      }
      // The installed package is matched to ITS OWN lock entry, keyed by the install
      // location, rather than to "any occurrence of this id anywhere in the lockfile".
      const key = lockKeyForPackageJsonPath(root, p.packageJsonPath);
      const locked = lockedVersionForKey(lockText, key, p.id);
      if (!locked.conclusive) {
        // Deliberately NOT a fallback onto `lockedVersionsFor`'s any-occurrence match —
        // that permissive match IS the defect. The other resolutions still ride the REASON,
        // so an operator gets the full diagnosis without the comparator accepting them.
        const elsewhere = lockedVersionsFor(lockText, p.id);
        const hint = elsewhere.conclusive
          ? ` (the id IS locked elsewhere at ${elsewhere.versions.join(", ")}, under a different install location — not evidence about this one)`
          : "";
        unknowns.push(`${p.id}: ${locked.reason}${hint}`);
        continue;
      }
      if (String(installed) !== locked.version) {
        drifts.push(`${p.id} installed ${installed}, lockfile resolves ${locked.version} for "${key}"`);
      }
    }
    if (drifts.length > 0) {
      verdicts.push(
        skew(
          "installed-vs-locked",
          `node_modules does not match the lockfile: ${drifts.join("; ")} — a partial or shadowed install; re-run 'bun install --frozen-lockfile' (a restart alone will NOT fix this)`,
        ),
      );
    } else if (unknowns.length > 0) {
      verdicts.push(unknown("installed-vs-locked", `could not compare: ${unknowns.join("; ")}`));
    } else {
      verdicts.push(ok("installed-vs-locked", `${packages.length} package(s) match the lockfile's resolution`));
    }
  }

  return summarize(verdicts);
}

// short — the first 12 hex chars of a digest, enough to distinguish two lockfiles in a
// log line without making it unreadable. NAME-only data; a lockfile digest is not secret.
function short(hash) {
  return typeof hash === "string" ? hash.replace(/^sha256:/, "").slice(0, 12) : String(hash);
}
export { short as shortDigest };

// ─── the durable restart budget (loop terminator) ───────────────────────────
//
// The self-heal predicate is self-clearing by construction — a relaunch re-captures the
// CURRENT lockfile digest, so `boot === current` again on the next boot. The budget exists
// for the pathological case that self-clearing cannot cover: a lockfile being rewritten
// continuously (a broken install loop), where every relaunch immediately re-observes a
// fresh mismatch. It is DURABLE (a file) rather than in-process because the whole point of
// the mechanism is that the process exits — an in-memory latch would reset every restart,
// which is precisely how "cleanup is load-bearing" fails.
//
// Same shape as health-responder.sh's attempt-cap markers: a window anchor plus a count,
// where the passage of time re-arms the budget for free.

// The ledger read is TRI-STATE, and the third state is the whole point. Collapsing
// "no file" and "a file I could not read or parse" into one `null` hands
// `classifyRestartBudget(null)` a FULL budget — so in enforce mode a corrupted or
// momentarily-unreadable ledger PERMITS another restart past the cap and then
// `recordRestartAttempt` overwrites the only surviving evidence of the previous one. The
// durable loop terminator would be disarmed by exactly the corruption it exists to survive.
//
//   • `null`                      — genuinely ABSENT (ENOENT/ENOTDIR): never spent, full
//                                   budget. This is the normal first-trip case.
//   • `RESTART_LEDGER_UNREADABLE` — a ledger is (or may be) on disk and could not be read
//                                   or parsed: the classifier declines, fail-closed.
//   • the parsed object           — grade it on its contents.
//
// A read error carrying no `code` (an exotic fs, an injected reader) classifies as
// UNREADABLE rather than absent, for the same reason the rest of this module fails closed:
// "I could not look" is never "it is not there".
export const RESTART_LEDGER_UNREADABLE = Object.freeze({ unreadable: true });

const LEDGER_ABSENT_CODES = new Set(["ENOENT", "ENOTDIR"]);

export function readRestartLedger(path, { readText = (p) => readFileSync(p, "utf8") } = {}) {
  let raw;
  try {
    raw = readText(path);
  } catch (err) {
    return LEDGER_ABSENT_CODES.has(err?.code) ? null : RESTART_LEDGER_UNREADABLE;
  }
  try {
    const parsed = JSON.parse(raw);
    // A bare `null`, a scalar, or an array is a file that EXISTS carrying something that is
    // not a ledger — corruption, not absence, so it must not re-arm the budget either.
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    return RESTART_LEDGER_UNREADABLE;
  } catch {
    return RESTART_LEDGER_UNREADABLE;
  }
}

// readLedgerFields — the RAW-TYPE gate, run BEFORE any numeric coercion, because `Number()`
// launders several distinct malformations into valid-looking numbers: `Number(null)` and
// `Number([])` are 0, `Number(true)` is 1, `Number("5")` is 5, and `Number(undefined) || 0`
// is 0. A syntactically valid ledger `{ts: null, count: 0}` therefore used to read as an
// anchor at the epoch — an "expired window" — and re-armed a FULL budget; a missing or
// non-numeric `count` coerced to zero and read as "nothing spent yet". Both are the
// fail-OPEN direction inside a guard whose entire purpose is to fail closed. So the types
// are CHECKED, never coerced: `typeof x === "number"` is the only test that rejects
// null/""/[]/true/"5" before a coercion can rescue them, and `Number.isFinite` then rejects
// NaN and ±Infinity.
function readLedgerFields(ledger) {
  if (ledger == null || typeof ledger !== "object" || Array.isArray(ledger)) return { ok: false, kind: "shape" };
  // Identity would be enough within one module instance; the property check also covers a
  // sentinel that crossed a module realm or a JSON round-trip.
  if (ledger === RESTART_LEDGER_UNREADABLE || ledger.unreadable === true) return { ok: false, kind: "unreadable" };
  if (typeof ledger.ts !== "number" || !Number.isFinite(ledger.ts)) return { ok: false, kind: "ts" };
  if (typeof ledger.count !== "number" || !Number.isInteger(ledger.count) || ledger.count < 0) return { ok: false, kind: "count" };
  return { ok: true, ts: ledger.ts, count: ledger.count };
}

const LEDGER_REFUSAL = {
  unreadable: "restart budget ledger exists but could not be read or parsed — declining the restart (fail-closed; an unreadable ledger is not an empty one)",
  shape: "restart budget ledger is malformed — declining the restart (fail-closed)",
  ts: "restart budget ledger has no usable timestamp (malformed or future-dated) — declining the restart (fail-closed)",
  count: "restart budget ledger has no usable count (absent or non-numeric) — declining the restart (fail-closed)",
};

// classifyRestartBudget — may this process spend a dep-skew restart? FAIL-CLOSED on a
// malformed, unreadable, or future-dated ledger: a corrupt-but-numeric or clock-skewed `ts`
// must not read as free budget (the same future-timestamp trap health-responder.sh hit,
// where a negative age was permanently "within grace"). Note the ordering: the type gate
// runs BEFORE the expired-window shortcut, so a ledger with a bogus count cannot re-arm the
// budget on the strength of an anchor read out of the same untrusted file. A corrupt ledger
// therefore holds restarts until an operator removes it — which is never destructive: a
// skewed-but-running writer is exactly today's behavior, and `catalyst doctor` names it.
export function classifyRestartBudget({ ledger = null, now = Date.now(), windowMs = 21_600_000, maxRestarts = 1 } = {}) {
  if (ledger === null || ledger === undefined) return { allowed: true, count: 0, reason: null };
  const fields = readLedgerFields(ledger);
  if (!fields.ok) return { allowed: false, count: null, reason: LEDGER_REFUSAL[fields.kind] };
  const { ts, count } = fields;
  if (ts > now) return { allowed: false, count: null, reason: LEDGER_REFUSAL.ts };
  if (now - ts >= windowMs) return { allowed: true, count: 0, reason: null };
  if (count >= maxRestarts) {
    return {
      allowed: false,
      count,
      reason: `dep-skew restart budget exhausted (${count}/${maxRestarts} in the last ${Math.round(windowMs / 60_000)}m) — holding; the skew is surfaced by 'catalyst doctor' instead`,
    };
  }
  return { allowed: true, count, reason: null };
}

// recordRestartAttempt — spend one unit of budget, atomically, BEFORE exiting. Returns the
// written ledger, or NULL when the write failed. Null is deliberately fail-CLOSED at the
// call site (the caller declines the restart): if the ledger is not durable the loop has
// no terminator, and declining a restart is never destructive — a skewed-but-running
// daemon is exactly today's behavior, which doctor now names.
export function recordRestartAttempt(path, { ledger = null, now = Date.now(), windowMs = 21_600_000 } = {}, { writeFile = writeFileSync, rename = renameSync } = {}) {
  // The SAME raw-type gate the classifier uses, for the same reason: a prior whose fields
  // cannot be trusted must not seed the next one. An unreadable/malformed prior anchors a
  // FRESH window at `now` with count 1 rather than inheriting a coerced anchor — the
  // conservative direction, since a fabricated older anchor would expire the window early
  // and silently re-arm the budget on the next tick.
  const prior = readLedgerFields(ledger);
  const withinWindow = prior.ok && prior.ts <= now && now - prior.ts < windowMs;
  const next = withinWindow ? { ts: prior.ts, count: prior.count + 1 } : { ts: now, count: 1 };
  try {
    const tmp = `${path}.tmp`;
    writeFile(tmp, JSON.stringify(next));
    rename(tmp, path);
    return next;
  } catch {
    return null; // not durable → the caller must NOT spend the restart
  }
}

// ─── heartbeat fields ───────────────────────────────────────────────────────

// depSkewFields — the skew observation, shaped for the writer's existing structured
// heartbeat line (stderr → cloud-sync.log → Alloy → Loki, service_name=catalyst.cloud-sync).
// Emitted from day one and in every mode, because "shadow with nobody watching" is the
// exact failure this ticket exists to remove: `restart_needed` was already a field in an
// event nobody watched. NAME-only data — digests and a mode, never a secret.
export function depSkewFields({ mode = null, bootLockHash = null, currentLockHash = null, skewed = null, sustained = null, wouldRestart = null } = {}) {
  return {
    "catalyst.cloud_sync.deps.mode": mode ?? null,
    "catalyst.cloud_sync.deps.skewed": skewed === null ? null : Boolean(skewed),
    "catalyst.cloud_sync.deps.sustained": sustained === null ? null : Boolean(sustained),
    "catalyst.cloud_sync.deps.would_restart": wouldRestart === null ? null : Boolean(wouldRestart),
    "catalyst.cloud_sync.deps.boot_lock_hash": bootLockHash ? short(bootLockHash) : null,
    "catalyst.cloud_sync.deps.current_lock_hash": currentLockHash ? short(currentLockHash) : null,
  };
}

// ─── the unified-log event (AC1: "the restart is visible in the event log") ──
//
// The heartbeat fields above ride stderr → cloud-sync.log → Alloy → Loki, which is a LOG
// stream: queryable, but not the same surface `catalyst-events wait-for`, the broker, the
// HUD, and orch-monitor read. AC1's second clause asks for the RESTART itself on
// `~/catalyst/events/YYYY-MM.jsonl`, and the capability was already present in cloud-sync.mjs
// and simply unused here — `emitWriterIdleEvent` writes a v2 envelope to that very file for
// the tokenless-writer case. So the dep-skew self-heal gets the same treatment, for the same
// reason the ticket exists: a restart nobody can observe is indistinguishable from no
// restart, which is exactly how `restart_needed` failed.
//
// TWO names rather than one name with an action attribute, because the alert that matters is
// "a writer restarted itself" and a Grafana/LogQL rule must be able to select it WITHOUT
// filtering on a payload field (otel-forward strips `body.payload` off-machine — everything
// load-bearing here therefore rides `attributes`):
//   • `…dep_skew_restart`       — the writer IS exiting now; the budget was spent and the
//                                 relaunch is launchd's. Emitted at most once per process.
//   • `…dep_skew_would_restart` — sustained skew that did NOT act: shadow mode (the shipping
//                                 default), an exhausted budget, or a ledger that could not be
//                                 persisted. `reason` names which.
export const DEP_SKEW_RESTART_EVENT = "catalyst.replica.dep_skew_restart";
export const DEP_SKEW_WOULD_RESTART_EVENT = "catalyst.replica.dep_skew_would_restart";

// depSkewEventEnvelope — the v2 OTel envelope, built PURELY so the shape is unit-testable
// without running the script-shaped writer. Everything non-deterministic (`ts`, the ids, the
// resource) is injected by the caller exactly as `emitWriterIdleEvent` supplies its own —
// which also keeps this module's zero-import property (node crypto/fs/path only), the one
// `catalyst doctor`'s bare-Node runtime depends on.
//
// The digest attributes come from `depSkewFields`, NOT from a second hand-written copy, so
// the event-log surface and the heartbeat line can never drift apart in what they name.
export function depSkewEventEnvelope({
  name,
  host = null,
  mode = null,
  reason = null,
  bootLockHash = null,
  currentLockHash = null,
  lockPath = null,
  sustained = null,
  wouldRestart = null,
  restart = false,
  ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  id = null,
  traceId = null,
  spanId = null,
  resource = null,
} = {}) {
  const acted = restart === true;
  return {
    ts,
    id,
    observedTs: ts,
    // WARN, matching the pino line this rides beside: a dep-skew episode is actionable but
    // not an outage — the writer is serving, just serving pre-change code.
    severityText: "WARN",
    severityNumber: 13,
    traceId,
    spanId,
    resource,
    attributes: {
      "event.name": name,
      "event.entity": "replica",
      "event.action": acted ? "dep_skew_restart" : "dep_skew_would_restart",
      "event.label": host,
      host,
      ...depSkewFields({ mode, bootLockHash, currentLockHash, skewed: true, sustained, wouldRestart }),
      "catalyst.cloud_sync.deps.restart": acted,
      "catalyst.cloud_sync.deps.lock_path": lockPath,
      "catalyst.cloud_sync.deps.reason": reason,
    },
    body: {
      message: acted
        ? `cloud-sync: restarting to load the installed dependency fix — the root lockfile changed since this writer loaded its modules (${lockPath ?? "lockfile path not recorded"})`
        : `cloud-sync: dependency skew detected, NOT restarting (mode=${mode ?? "?"}): ${reason ?? "held"}`,
    },
  };
}
