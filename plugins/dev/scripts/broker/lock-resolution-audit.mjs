// lock-resolution-audit.mjs — did the install actually RELINK, or merely exit 0?
// (CTL-1831)
//
// MEASURED 2026-08-13 on `mini`, immediately after #3337 moved the root bun.lock
// from @catalyst-cloud/schema@0.1.3 to 0.1.5. The refresh pulled the merge
// correctly — plugin-source HEAD and bun.lock were both right — and then:
//
//   bun install --frozen-lockfile   (what plugin-refresh runs)  -> 0.1.3, "no changes", exit 0
//   bun install                     (its fallback)              -> 0.1.3, "no changes", exit 0
//   bun install --force                                         -> 0.1.5
//
// Bun will not relink an existing node_modules when only a TRANSITIVE resolution
// changed, and both no-op commands exit 0 — so "the install succeeded" and "the
// install changed nothing" are byte-identical to the caller. plugin-refresh
// already surfaces install FAILURE as deps_install_failed; a no-op produced no
// signal at all, which is why a correct lockfile reached every host's disk and
// still never reached the running code (the CTL-1506 chain's second link; the
// fleet was unblocked that day only by running --force by hand on three hosts).
//
// THE DISCRIMINATOR, and why it is not the obvious one: the check must read the
// IMPORTING package's resolved dependency, NOT the hoisted top-level copy.
// cloud-sync.mjs imports @catalyst-cloud/schema THROUGH the SDK, and under bun's
// isolated linker there is frequently no top-level copy at all (measured in this
// repo: `require.resolve("@catalyst-cloud/schema")` from the workspace root is
// MODULE_NOT_FOUND while the SDK resolves it fine). A top-level probe would have
// reported "absent" or "fine" and never seen the stale 0.1.3 the daemons loaded.
//
// Resolution — not directory enumeration — is the only honest instrument here.
// bun's `.bun` store keeps STALE entries after an upgrade (measured on this
// checkout: @catalyst-cloud+schema@0.1.3 and @0.1.5 both present, and
// @catalyst-cloud+sdk@0.8.1 alongside 0.8.2), so "0.1.3 exists on disk" says
// nothing about what any importer loads. Only a resolve from the importer's own
// directory answers that, and it is layout-agnostic: it works identically under
// the hoisted and isolated linkers because both are built to make resolution
// give the right answer.
//
// The single filesystem interaction is the injected `resolvePackageFn(fromDir,
// id) -> {dir, version} | null` seam, so the whole audit is deterministically
// testable without a real node_modules. Mirrors the seam-injection convention of
// plugin-refresh.mjs / cloud-sync-deps.mjs.

// ─── lock key parsing ────────────────────────────────────────────────────────

/**
 * splitLockKey — bun keys its `packages` map by install LOCATION: `<id>` for a
 * hoisted resolution, `<parent>/<id>` for a nested one, chaining deeper
 * (measured in this repo's own bun.lock:
 * `@typescript-eslint/typescript-estree/minimatch/brace-expansion/balanced-match`).
 *
 * A naive `split("/")` cannot tell a scoped package name from a nesting hop, so
 * this consumes a leading `@` segment together with the segment after it.
 * Returns null — never a guessed chain — for a dangling scope or a non-string,
 * because a caller that cannot identify the importer must report inconclusive
 * rather than probe the wrong directory.
 *
 * @returns {string[]|null}
 */
export function splitLockKey(key) {
  if (typeof key !== "string" || key.length === 0) return null;
  const parts = key.split("/");
  const chain = [];
  for (let i = 0; i < parts.length; i += 1) {
    const seg = parts[i];
    if (seg.length === 0) return null;
    if (seg.startsWith("@")) {
      if (i + 1 >= parts.length) return null; // a scope with no package after it
      chain.push(`${seg}/${parts[i + 1]}`);
      i += 1;
    } else {
      chain.push(seg);
    }
  }
  return chain.length > 0 ? chain : null;
}

// A `packages` entry line, as bun writes it:
//     "<key>": ["<name>@<version>", "<resolution>", {<meta>}, "<integrity>"],
// Anchored at the start of the line so the `"optionalPeers": ["…"]` array that
// lives INSIDE an entry (and any other mid-line `"key": ["`) cannot match.
const ENTRY_RE = /^\s*"([^"]+)"\s*:\s*\[\s*"([^"]+)"/;

// The `"packages": {` block opener and its 2-space closing brace. Scanning only
// inside that block keeps the `workspaces` / `overrides` blocks out of the map.
const PACKAGES_OPEN_RE = /^\s{0,4}"packages"\s*:\s*\{\s*$/;
const BLOCK_CLOSE_RE = /^\s{0,3}\}/;

// A workspace member is recorded as `<name>@workspace:<path>` — a link, not an
// installed artifact. It has no resolution to materialize, so it never
// contributes a change the audit could verify on disk.
const WORKSPACE_VERSION_PREFIX = "workspace:";

/**
 * parseLockPackages — the lockfile's `packages` map as structured data.
 *
 * STRUCTURED, not a substring grep: each entry is anchored on the line-leading
 * key AND the value's first array element, and the id/version split is taken at
 * the LAST `@` so a scoped name (`@catalyst-cloud/schema@0.1.5`) survives. An
 * unstructured match over structured data is one of the four mechanisms that has
 * produced a false clean result in this repo before.
 *
 * Three-valued: text that is empty, non-string, or has no `packages` block is
 * INCONCLUSIVE with a reason — never an empty map, which every downstream
 * comparison would read as "nothing changed, all clean".
 *
 * @returns {{conclusive:boolean, reason:string|null,
 *            packages: Map<string,{key:string,id:string,version:string,
 *                                  workspaceLink:boolean, declaredDeps:string[]|null}>}}
 */
export function parseLockPackages(lockText) {
  const packages = new Map();
  if (typeof lockText !== "string" || lockText.length === 0) {
    return { conclusive: false, reason: "lockfile text unavailable", packages };
  }
  const lines = lockText.split("\n");
  let inBlock = false;
  let sawBlock = false;
  for (const line of lines) {
    if (!inBlock) {
      if (PACKAGES_OPEN_RE.test(line)) {
        inBlock = true;
        sawBlock = true;
      }
      continue;
    }
    if (BLOCK_CLOSE_RE.test(line)) {
      inBlock = false;
      continue;
    }
    const m = ENTRY_RE.exec(line);
    if (!m) continue;
    const [, key, first] = m;
    const at = first.lastIndexOf("@");
    if (at <= 0) continue; // no `name@version` shape — not a package entry
    const id = first.slice(0, at);
    const version = first.slice(at + 1);
    packages.set(key, {
      key,
      id,
      version,
      workspaceLink: version.startsWith(WORKSPACE_VERSION_PREFIX),
      declaredDeps: declaredDepsOf(line),
    });
  }
  if (!sawBlock) {
    return { conclusive: false, reason: 'no "packages" block found in the lockfile text', packages };
  }
  return { conclusive: true, reason: null, packages };
}

// declaredDepsOf — the dependency ids an entry declares, read out of its metadata
// object (the third array element). Returns null — meaning "could not look" —
// when the object cannot be located or parsed, so the caller can render that as
// inconclusive rather than as "this package declares nothing".
//
// The object is extracted by brace matching rather than by regex, because a
// dependency RANGE can itself contain braces-free but quoted content and the
// entry's trailing integrity string must not be swallowed. Brace matching is
// safe here for the same reason bun can write the file at all: the metadata
// object is emitted as plain JSON on one line.
function declaredDepsOf(line) {
  const open = line.indexOf("{");
  if (open === -1) return [];
  let depth = 0;
  let close = -1;
  for (let i = open; i < line.length; i += 1) {
    if (line[i] === "{") depth += 1;
    else if (line[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1) return null;
  let meta;
  try {
    meta = JSON.parse(line.slice(open, close + 1));
  } catch {
    return null;
  }
  const out = [];
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const block = meta?.[field];
    if (block && typeof block === "object" && !Array.isArray(block)) out.push(...Object.keys(block));
  }
  return [...new Set(out)];
}

// ─── change detection ────────────────────────────────────────────────────────

/**
 * changedResolutions — the entries whose resolution the pulled range MOVED.
 *
 * Only entries that are new or whose version changed: those are the ones that
 * must be materialized on disk by the install that follows. A REMOVED entry
 * needs nothing materialized (the leftover copy is unreachable debris, and bun's
 * store keeps it around regardless), and a `workspace:` link is not an installed
 * artifact at all.
 *
 * Restricting the audit to the CHANGED entries is what keeps it cheap enough to
 * run on every refresh: a merge typically moves a handful of resolutions, versus
 * the 1168 packages a blanket `--force` re-extracts (3-8 s measured).
 *
 * Three-valued: if either side cannot be parsed the result is INCONCLUSIVE with
 * a reason and an EMPTY entry list — a caller must be able to tell "nothing
 * changed" from "I could not look".
 *
 * @returns {{conclusive:boolean, reason:string|null,
 *            entries:{key:string,id:string,from:string|null,to:string}[]}}
 */
export function changedResolutions(oldLockText, newLockText) {
  const before = parseLockPackages(oldLockText);
  const after = parseLockPackages(newLockText);
  if (!before.conclusive || !after.conclusive) {
    const which = !before.conclusive ? `previous lockfile (${before.reason})` : `new lockfile (${after.reason})`;
    return { conclusive: false, reason: `cannot compare resolutions: ${which}`, entries: [] };
  }
  const entries = [];
  for (const [key, now] of after.packages) {
    if (now.workspaceLink) continue;
    const then = before.packages.get(key);
    if (then && then.version === now.version) continue;
    entries.push({ key, id: now.id, from: then?.version ?? null, to: now.version });
  }
  return { conclusive: true, reason: null, entries };
}

// ─── the on-disk audit ───────────────────────────────────────────────────────

/**
 * auditLockResolution — for every resolution the pulled range moved, does the
 * IMPORTING package on disk actually resolve the locked version?
 *
 * Importer selection is what keeps this both precise and free of false alarms:
 *
 *   - a NESTED key (`chalk/ansi-styles`) names its own importer. It is judged
 *     from that parent's directory ONLY. Judging it from the workspace root
 *     would compare against the hoisted copy — a legitimately different version
 *     — and force a needless 1168-package re-extract on every refresh.
 *   - a BARE key is the single graph-wide resolution for that id, so every
 *     importer must agree. Sites are the workspace roots plus every lockfile
 *     entry that DECLARES the id, each located by resolving it from a workspace
 *     root. A declarer that carries its own nested key for the id is excluded —
 *     it resolves the other entry, not this one.
 *
 * An observed version that the lockfile records ELSEWHERE for the same id is an
 * `alternate`, not a mismatch: a legitimate second resolution must not trigger a
 * force. Only a version the lockfile records NOWHERE for that id proves the tree
 * was not materialized from this lockfile — which is exactly the measured
 * incident (after #3337 the lockfile recorded 0.1.5 and only 0.1.5, and the disk
 * held 0.1.3).
 *
 * FAIL-CLOSED THROUGHOUT. An unusable lockfile, an empty site list, an
 * unlocatable importer, or a throwing resolver each produce an explicit
 * INCONCLUSIVE — never a clean pass. `[].every(p)` is `true`, and a zero-site
 * loop that prints an all-clear on the strength of zero iterations is one of the
 * false-clean mechanisms this repo has actually shipped.
 *
 * @param {object}   opts
 * @param {string[]} opts.workspaceRoots  dirs to resolve from (lock dir + literal members)
 * @param {string?}  opts.oldLockText     lockfile content at the pre-pull sha
 * @param {string?}  opts.newLockText     lockfile content on disk now
 * @param {Function} opts.resolvePackageFn (fromDir, id) => {dir, version} | null
 */
export function auditLockResolution({
  workspaceRoots = [],
  oldLockText = null,
  newLockText = null,
  resolvePackageFn,
} = {}) {
  const empty = { checked: 0, matched: [], mismatched: [], alternates: [], inconclusive: [] };

  const change = changedResolutions(oldLockText, newLockText);
  if (!change.conclusive) return { ...empty, conclusive: false, reason: change.reason };
  if (change.entries.length === 0) return { ...empty, conclusive: true, reason: null };

  // The vacuity guard, asserted BEFORE the per-entry loop: with no site to probe
  // every entry would fall through the loop body and the audit would report a
  // clean tree it never looked at.
  const roots = Array.isArray(workspaceRoots) ? workspaceRoots.filter((r) => typeof r === "string" && r) : [];
  if (roots.length === 0) {
    return { ...empty, conclusive: false, reason: "no workspace root to resolve from — nothing could be probed" };
  }
  if (typeof resolvePackageFn !== "function") {
    return { ...empty, conclusive: false, reason: "no package resolver supplied — nothing could be probed" };
  }

  const parsed = parseLockPackages(newLockText);
  const lockedVersionsById = new Map();
  for (const entry of parsed.packages.values()) {
    if (entry.workspaceLink) continue;
    if (!lockedVersionsById.has(entry.id)) lockedVersionsById.set(entry.id, new Set());
    lockedVersionsById.get(entry.id).add(entry.version);
  }

  // resolve/locate memo — one probe per (fromDir, id) across the whole audit.
  const memo = new Map();
  const resolve = (fromDir, id) => {
    const cacheKey = `${fromDir} ${id}`;
    if (memo.has(cacheKey)) return memo.get(cacheKey);
    let out = null;
    try {
      const r = resolvePackageFn(fromDir, id);
      out = r && typeof r.version === "string" && r.version ? r : null;
    } catch {
      out = null; // a throwing probe is "could not look", never "not there"
    }
    memo.set(cacheKey, out);
    return out;
  };

  const matched = [];
  const mismatched = [];
  const alternates = [];
  const inconclusive = [];

  for (const entry of change.entries) {
    const chain = splitLockKey(entry.key);
    if (!chain) {
      inconclusive.push({ ...entry, reason: `lockfile key "${entry.key}" is not a parseable install location` });
      continue;
    }

    // ── site selection (see the doc comment above) ──
    const sites = [];
    const unlocatable = [];
    if (chain.length > 1) {
      const parentId = chain[chain.length - 2];
      let located = null;
      for (const root of roots) {
        located = resolve(root, parentId);
        if (located) break;
      }
      if (located) sites.push({ importer: parentId, dir: located.dir });
      else unlocatable.push(parentId);
    } else {
      for (const root of roots) sites.push({ importer: `workspace:${root}`, dir: root });
      for (const pkg of parsed.packages.values()) {
        if (pkg.workspaceLink) continue;
        if (!Array.isArray(pkg.declaredDeps) || !pkg.declaredDeps.includes(entry.id)) continue;
        // A declarer with its own nested key for this id resolves THAT entry, not
        // this bare one — probing it would compare against the wrong resolution.
        if (parsed.packages.has(`${pkg.key}/${entry.id}`)) continue;
        let located = null;
        for (const root of roots) {
          located = resolve(root, pkg.id);
          if (located) break;
        }
        if (located) sites.push({ importer: pkg.id, dir: located.dir });
        else unlocatable.push(pkg.id);
      }
    }

    // ── probe every site ──
    const observations = [];
    for (const site of sites) {
      const got = resolve(site.dir, entry.id);
      if (!got) continue; // not reachable from this importer — not evidence either way
      observations.push({ importer: site.importer, version: got.version, path: got.dir ?? null });
    }

    if (observations.length === 0) {
      inconclusive.push({
        ...entry,
        reason:
          `no importer on disk resolves ${entry.id}` +
          (unlocatable.length > 0 ? ` (could not locate: ${unlocatable.join(", ")})` : ""),
      });
      continue;
    }

    const lockedElsewhere = lockedVersionsById.get(entry.id) ?? new Set();
    const wrong = observations.filter((o) => o.version !== entry.to && !lockedElsewhere.has(o.version));
    const other = observations.filter((o) => o.version !== entry.to && lockedElsewhere.has(o.version));

    if (wrong.length > 0) {
      mismatched.push({
        ...entry,
        expected: entry.to,
        found: [...new Set(wrong.map((o) => o.version))],
        importers: [...new Set(wrong.map((o) => o.importer))],
        paths: [...new Set(wrong.map((o) => o.path).filter(Boolean))],
      });
    } else if (other.length > 0) {
      alternates.push({
        ...entry,
        expected: entry.to,
        found: [...new Set(other.map((o) => o.version))],
        importers: [...new Set(other.map((o) => o.importer))],
      });
    } else {
      matched.push({ ...entry, importers: [...new Set(observations.map((o) => o.importer))] });
    }
  }

  return {
    conclusive: true,
    reason: null,
    checked: change.entries.length,
    matched,
    mismatched,
    alternates,
    inconclusive,
  };
}
