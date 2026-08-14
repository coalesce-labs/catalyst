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
// Placement — not directory enumeration — is the only honest instrument here.
// bun's `.bun` store keeps STALE entries after an upgrade (measured on this
// checkout: @catalyst-cloud+schema@0.1.3 and @0.1.5 both present, and
// @catalyst-cloud+sdk@0.8.1 alongside 0.8.2), so "0.1.3 exists on disk" says
// nothing about what any importer loads. Only the entry the importer's own
// node_modules ladder lands on answers that, and reading that ladder is
// layout-agnostic: under the hoisted linker the rung IS the package, under the
// isolated linker it is a symlink into `.bun/`, and a plain file read follows
// either.
//
// The single filesystem interaction is the injected `resolvePackageFn(fromDir,
// id) -> {dir, version} | null` seam, so the whole audit is deterministically
// testable without a real node_modules. Mirrors the seam-injection convention of
// plugin-refresh.mjs / cloud-sync-deps.mjs.
//
// CONTRACT ON THAT SEAM, and the trap the first implementation fell into: it
// must answer from the DISK ON EVERY CALL. `createRequire().resolve()` looks
// like the obvious implementation and is disqualified — Node/bun module
// resolution is cached PROCESS-WIDE and a fresh `createRequire` does not clear
// it, so inside a long-lived daemon the post-`--force` re-audit re-reads the
// pre-force answer and a process that once saw a good tree never sees it go
// stale. See `plugin-refresh.mjs` `defaultResolvePackageFn` for the ladder walk
// that satisfies this.

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
 * normalizeWorkspaceRoots — accept a bare dir string OR `{dir, name}`, and drop
 * anything that is neither. `name` is the root's own package name; it is what
 * makes the bare-key member-nesting exclusion PRECISE (shed exactly the member
 * whose `<name>/<id>` key exists) instead of blunt.
 *
 * A string entry is kept, with `name: null` — "present, name unknown" — rather
 * than rejected, because the caller contract predates the name and every unit
 * test passes bare dirs. The fallback for an unnamed root is deliberately blunt
 * (see rootShadowedByOwnNestedKey): it cannot tell WHICH member nests an id, so
 * it sheds every unnamed root for that id. Shedding is the safe direction — a
 * site list that empties reports INCONCLUSIVE, never a clean pass.
 *
 * @returns {{dir:string, name:string|null}[]}
 */
function normalizeWorkspaceRoots(workspaceRoots) {
  if (!Array.isArray(workspaceRoots)) return [];
  const out = [];
  for (const root of workspaceRoots) {
    if (typeof root === "string" && root) {
      out.push({ dir: root, name: null });
      continue;
    }
    if (root && typeof root === "object" && typeof root.dir === "string" && root.dir) {
      out.push({ dir: root.dir, name: typeof root.name === "string" && root.name ? root.name : null });
    }
  }
  return out;
}

/**
 * auditLockResolution — for every resolution the pulled range moved, does the
 * IMPORTING package on disk actually resolve the locked version?
 *
 * Importer selection is what keeps this both precise and free of false alarms:
 *
 *   - a NESTED key (`chalk/ansi-styles`) names its own importer: the WHOLE key
 *     minus the last element is an install PATH, and the importer is reached by
 *     resolving each element of that path in sequence from a workspace root.
 *     Resolving only the immediate parent is wrong for anything deeper than one
 *     hop — this repo's own bun.lock really carries
 *     `@typescript-eslint/typescript-estree/minimatch/brace-expansion/balanced-match`
 *     (measured: 48 nested keys, 5 of them deeper than one hop, max chain 4) —
 *     because the parent named by that path is `brace-expansion` UNDER
 *     `minimatch` UNDER `typescript-estree`, not whichever `brace-expansion`
 *     happens to be visible from the root. A root-visible parent that is a
 *     separately hoisted copy makes the audit probe the wrong tree; an absent
 *     one makes it inconclusive. It is judged from that located parent ONLY —
 *     judging it from the workspace root would compare against the hoisted copy,
 *     a legitimately different version, and force a needless 1168-package
 *     re-extract on every refresh.
 *   - a BARE key is the single graph-wide resolution for that id, so every
 *     importer must agree. Sites are the workspace roots plus every lockfile
 *     entry that DECLARES the id, each located by resolving it from a workspace
 *     root. A site that carries its OWN nested key for the id is excluded — it
 *     resolves that entry, not this bare one. That exclusion applies to BOTH
 *     kinds of site: to a declarer (`<declarer>/<id>`) and to a workspace member
 *     root (`<member>/<id>`, which this repo's lockfile really has three of:
 *     `orch-monitor-ui/react`, `orch-monitor-ui/@types/react`,
 *     `orch-monitor-ui/typescript`, and `plugins/dev/scripts/orch-monitor/ui` is
 *     a literal workspace member the caller passes as a root). Shedding the
 *     member ROOT is not enough on its own: entitlement to the member's nested
 *     version belongs to the whole subtree reached THROUGH that root, so a
 *     declarer is located only from the roots that survived the shed. Locating
 *     it by first hit across every root is the bare-key twin of the one-hop bug
 *     the deep path already fixes — bun's isolated linker writes a separate,
 *     peer-disambiguated store entry per peer set while the lockfile records ONE
 *     bare entry covering all of them, so `packages.has("<declarer>/<id>")` is
 *     false and the nested-key exclusion cannot see the difference. Reproducible
 *     on this checkout: the lockfile holds a single bare `eslint@9.39.5` entry
 *     with NO nested key anywhere, and the store holds two copies of it
 *     (`.bun/eslint@9.39.5+1a1acd4c2fa5b1a4` and `+5e91b0bf22d6303b`), which
 *     resolve `@eslint-community/eslint-utils` to two DIFFERENT store dirs
 *     (`…+5e91b0bf22d6303b` vs `…+bd61bba68491e3a8`) — same version, different
 *     peer set, one lock key. Measured on this repo's real tree, a bare `react`
 *     move reported 16 false mismatched importers, every one of them located
 *     through `orch-monitor-ui`, and `bun install --force` cannot clear it
 *     because the placement is lockfile-determined. A declarer reachable ONLY
 *     through a shed root is reported by name in the inconclusive reason, never
 *     folded into "could not locate".
 *
 *     Selecting the right ROOT is only half of it: the declarer must also be
 *     located as the COPY ITS OWN LOCK KEY NAMES. A site is excluded by
 *     `pkg.key` but was located by `pkg.id`, so a nested declarer was found at
 *     whatever the first bare hit from a root happened to be — frequently the
 *     copy of the entry that exclusion had just shed. It is therefore located by
 *     walking its own key as an install path, version-checked at every hop
 *     (`walkInstallPath`, which carries the measurement). A hop that lands on a
 *     version the lockfile does not record for that path is NOT evidence about
 *     this key, in either direction: it can neither raise a mismatch nor
 *     contribute to a match, and it is named on the verdict as `wrongCopy`.
 *
 * Because site selection already sheds every site entitled to a different
 * version, a SELECTED site that resolves anything other than the locked version
 * is a MISMATCH — including a version the lockfile records elsewhere for the
 * same id. Excusing those as a benign "alternate" hid the exact defect this
 * module exists to catch: with bare `x` moving 1.0.0 -> 2.0.0 while a nested
 * `a/x` legitimately stays at 1.0.0, a stale workspace-root link at 1.0.0 was
 * labelled an alternate, `refreshPluginCheckout` ignores alternates, no force
 * ever ran, and the bare resolution stayed stale.
 *
 * FAIL-CLOSED THROUGHOUT. An unusable lockfile, an empty site list, an
 * unlocatable importer, a broken hop part-way along an install path, or a
 * throwing resolver each produce an explicit INCONCLUSIVE — never a clean pass
 * and never a probe of a half-walked directory. `[].every(p)` is `true`, and a zero-site
 * loop that prints an all-clear on the strength of zero iterations is one of the
 * false-clean mechanisms this repo has actually shipped.
 *
 * @param {object} opts
 * @param {(string|{dir:string,name:string|null})[]} opts.workspaceRoots
 *        dirs to resolve from (lock dir + literal members). An entry may be a
 *        bare dir string or `{dir, name}`; `name` is the root's own package
 *        name, which is what lets the bare-key exclusion above name the ONE
 *        member root a `<member>/<id>` key shadows. See normalizeWorkspaceRoots
 *        for the deliberately blunt fallback when a name is not supplied.
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
  const empty = { checked: 0, matched: [], mismatched: [], inconclusive: [] };

  const change = changedResolutions(oldLockText, newLockText);
  if (!change.conclusive) return { ...empty, conclusive: false, reason: change.reason };
  if (change.entries.length === 0) return { ...empty, conclusive: true, reason: null };

  // The vacuity guard, asserted BEFORE the per-entry loop: with no site to probe
  // every entry would fall through the loop body and the audit would report a
  // clean tree it never looked at.
  const roots = normalizeWorkspaceRoots(workspaceRoots);
  if (roots.length === 0) {
    return { ...empty, conclusive: false, reason: "no workspace root to resolve from — nothing could be probed" };
  }
  if (typeof resolvePackageFn !== "function") {
    return { ...empty, conclusive: false, reason: "no package resolver supplied — nothing could be probed" };
  }

  const parsed = parseLockPackages(newLockText);

  // The lockfile's workspace members, by package name — the possible parents of
  // a `<member>/<id>` key, which is how a member root legitimately resolves a
  // version other than the bare one.
  const memberNames = [];
  for (const pkg of parsed.packages.values()) if (pkg.workspaceLink) memberNames.push(pkg.id);

  /**
   * governingEntryFor — the lockfile entry that decides what `id` resolves to
   * FROM a copy installed at `parentChain`, or null if the lockfile records no
   * resolution for it at all.
   *
   * Resolution climbs, so entitlement climbs with it: the governing entry is the
   * one keyed by the LONGEST prefix of `parentChain` that carries `<prefix>/<id>`
   * — the copy's own nested key first, then each ancestor's, and only if no
   * ancestor nests it does the BARE `<id>` entry govern.
   *
   * Asking only about the copy's OWN key (`<parentChain>/<id>`) is a real
   * false-ERROR source, MEASURED on this repo's tree. bun nests one level from a
   * top-level entry: `@opentelemetry/exporter-trace-otlp-http/@opentelemetry/
   * sdk-trace-base` (2.8.0) and `@opentelemetry/exporter-trace-otlp-http/
   * @opentelemetry/resources` (2.8.0) are SIBLINGS under the exporter, and there
   * is no `…/sdk-trace-base/@opentelemetry/resources` key. So sdk-trace-base@2.8.0
   * is entitled to resources 2.8.0 by its PARENT's key, while the bare
   * `@opentelemetry/resources` entry is 2.10.0. An own-key-only test selects it
   * as a site for the bare 2.10.0 move and reports `expected 2.10.0, found
   * ["2.8.0"]` on a tree that is correct on disk.
   */
  const governingEntryFor = (parentChain, id) => {
    for (let i = parentChain.length; i >= 1; i -= 1) {
      const nested = parsed.packages.get(`${parentChain.slice(0, i).join("/")}/${id}`);
      if (nested) return nested;
    }
    return parsed.packages.get(id) ?? null;
  };

  // rootShadowedByOwnNestedKey — does this workspace root resolve `id` through
  // its OWN nested lock entry rather than the bare one? Named root: ask exactly
  // that root's key. Unnamed root: we cannot tell which member nests the id, so
  // if ANY member does, shed every unnamed root for this entry (safe direction —
  // see normalizeWorkspaceRoots).
  const rootShadowedByOwnNestedKey = (root, id) =>
    root.name
      ? parsed.packages.has(`${root.name}/${id}`)
      : memberNames.some((member) => parsed.packages.has(`${member}/${id}`));

  // siteEntitledElsewhere — does a copy installed at `parentChain` resolve `id`
  // through some nested entry rather than the bare one? Then it is judged at
  // that entry, not here, and probing it would compare against the wrong
  // resolution. Key identity, not version equality, is the test: two entries
  // that happen to carry the same version are still two entries, and shedding is
  // the safe direction (a site list that empties reports INCONCLUSIVE).
  const siteEntitledElsewhere = (parentChain, id) => {
    const governing = governingEntryFor(parentChain, id);
    return governing !== null && governing.key !== id;
  };

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

  /**
   * walkInstallPath — locate the copy an install PATH names, hop by hop from
   * `rootDir`, CHECKING AT EVERY HOP that the copy landed on is the one the
   * lockfile records for that path.
   *
   * The check is the whole point, and the discriminator was already in hand and
   * unused: `resolvePackageFn` returns the located package's OWN version, and a
   * site selected by lock key K but located at a copy whose version disagrees
   * with K is a probe of a DIFFERENT copy — an observation that is not evidence
   * about K, in either direction.
   *
   * MEASURED on this repo's real bun.lock + node_modules (node v25.8.2 / bun
   * 1.3.5, macOS 26.5): the lockfile records `@opentelemetry/resources` at
   * 2.8.0 under six parents AND at 2.10.0 as its own bare entry, and both store
   * copies exist and are both correct:
   *
   *   .bun/@opentelemetry+resources@2.8.0+e40b…/…  -> @opentelemetry/core 2.8.0
   *   .bun/@opentelemetry+resources@2.10.0+e40b…/… -> @opentelemetry/core 2.10.0
   *
   * Locating `@opentelemetry/sdk-logs/@opentelemetry/resources` by a bare
   * `resolve(root, "@opentelemetry/resources")` takes the FIRST hit from the
   * root — the 2.10.0 copy, i.e. the copy of the very entry the nested-key
   * exclusion had just shed — and then judged its core@2.10.0 against the bare
   * lock's 2.8.0. That produced `deps_relink_failed, expected 2.8.0,
   * found ["2.10.0"]` on a tree that is CORRECT on disk, so no install could
   * ever repair it: a permanent ERROR, the same shape as the react incident
   * reached by a different route. Measured over all 689 bare ids, 5 ids had at
   * least one such site: `@opentelemetry/core` (6 sites) produced the live false
   * ERROR, and `@opentelemetry/api` (6), `@opentelemetry/semantic-conventions`
   * (6), `@opentelemetry/resources` (2) and `csstype` (2) read `matched` ONLY
   * because the wrong copy happened to agree — a latent FALSE CLEAN in the other
   * direction. One defect, both failure modes.
   *
   * Walking the declarer's OWN key path fixes both: root ->
   * `@opentelemetry/exporter-trace-otlp-http` -> `@opentelemetry/resources`
   * lands on the 2.8.0 copy and judges THAT.
   *
   * Three failure kinds, kept distinct because they mean different things to an
   * operator: `absent` (a hop is not on disk — could not look), `wrong-copy`
   * (the hop resolved a version the lockfile does not record for that path — we
   * looked at the wrong thing), `unanchored` (no lock entry governs the path, so
   * right and wrong cannot be told apart). All three are non-evidence; NONE of
   * them may become a silent `matched`.
   *
   * A `workspace:` hop is exempt from the version check ONLY: a workspace link
   * has no installed version to compare (its recorded "version" is the literal
   * `workspace:<path>`), and it is identified by name, not by version.
   */
  const walkInstallPath = (rootDir, pathChain) => {
    let cursor = rootDir;
    for (let i = 0; i < pathChain.length; i += 1) {
      const at = pathChain.slice(0, i + 1).join("/");
      const step = resolve(cursor, pathChain[i]);
      if (!step || typeof step.dir !== "string" || !step.dir) return { ok: false, kind: "absent", at };
      const governing = governingEntryFor(pathChain.slice(0, i), pathChain[i]);
      if (!governing) return { ok: false, kind: "unanchored", at };
      if (!governing.workspaceLink && step.version !== governing.version) {
        return { ok: false, kind: "wrong-copy", at, want: governing.version, got: step.version };
      }
      cursor = step.dir;
    }
    return { ok: true, dir: cursor };
  };

  // A walk that failed for a reason OTHER than "the hop is simply not there" —
  // rendered for the inconclusive reason so the operator can tell "I could not
  // look" from "I looked at the wrong copy".
  const describeBadWalk = (label, walk) =>
    walk.kind === "wrong-copy"
      ? `${label} (install path ${walk.at}: the lockfile records ${walk.want} there, the located copy is ${walk.got})`
      : `${label} (install path ${walk.at}: no lockfile entry governs it)`;

  const matched = [];
  const mismatched = [];
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
    const shedThroughNestedRoot = [];
    const wrongCopy = [];
    if (chain.length > 1) {
      // The key minus its last element is an install PATH, not a single parent.
      // Walk it hop by hop — root -> chain[0] -> chain[1] -> … — so the importer
      // located is the copy the path actually names. Resolving only
      // chain[length-2] from a root finds whichever copy is root-visible, which
      // for a deep key is either absent (inconclusive) or a separately hoisted
      // copy in a different tree (the wrong probe, silently). Every hop is
      // version-checked against the lock entry governing it (walkInstallPath),
      // so a hop that lands on a peer copy the path does not name is rejected
      // rather than followed into the wrong subtree.
      const parentPath = chain.slice(0, -1);
      const importer = parentPath.join("/");
      let importerDir = null;
      let badWalk = null;
      for (const root of roots) {
        const walk = walkInstallPath(root.dir, parentPath);
        if (walk.ok) {
          importerDir = walk.dir;
          break;
        }
        if (!badWalk && walk.kind !== "absent") badWalk = walk;
      }
      if (importerDir) sites.push({ importer, dir: importerDir });
      else if (badWalk) wrongCopy.push(describeBadWalk(importer, badWalk));
      else unlocatable.push(importer);
    } else {
      // The roots ENTITLED to the bare resolution. A member root carrying its
      // own `<member>/<id>` key resolves THAT entry, not this bare one — and
      // that entitlement is a property of the whole subtree reached through
      // the root, not of the root directory alone. So this one list governs
      // BOTH kinds of site below: the roots probed directly, and the roots a
      // declarer may be LOCATED from.
      const bareRoots = roots.filter((root) => !rootShadowedByOwnNestedKey(root, entry.id));
      for (const root of bareRoots) {
        sites.push({ importer: `workspace:${root.dir}`, dir: root.dir });
      }
      for (const pkg of parsed.packages.values()) {
        if (pkg.workspaceLink) continue;
        if (!Array.isArray(pkg.declaredDeps) || !pkg.declaredDeps.includes(entry.id)) continue;
        const declarerPath = splitLockKey(pkg.key);
        if (!declarerPath) {
          unlocatable.push(pkg.key);
          continue;
        }
        // A declarer whose resolution of this id is governed by a nested entry —
        // its OWN or any ANCESTOR's — resolves THAT entry, not this bare one;
        // probing it would compare against the wrong resolution. Testing only
        // the declarer's own key misses the sibling case bun really produces
        // (see governingEntryFor for the measurement).
        if (siteEntitledElsewhere(declarerPath, entry.id)) continue;
        // Locate the declarer only from a bare-entitled root, and locate it by
        // walking its OWN lock key as an install path — never by a bare
        // `resolve(root.dir, pkg.id)` first hit.
        //
        // Two distinct bugs are excluded here, and only the first was closed
        // before. (1) Root SELECTION: taking the first hit across ALL roots is
        // the bare-key twin of the one-hop bug the deep path already fixes —
        // bun's isolated linker writes a SEPARATE, peer-disambiguated store
        // entry per peer set (reproducible here: one bare `eslint@9.39.5` lock
        // entry with no nested key anywhere, two store copies of it) while the
        // lockfile records ONE bare entry for all of them, so
        // `parsed.packages.has("<declarer>/<id>")` is false and the nested-key
        // exclusion above cannot see the distinction; that reported 16 false
        // mismatched importers for `react`. (2) COPY selection, the
        // defect this walk closes: a declarer is EXCLUDED above by `pkg.key`
        // but was LOCATED by `pkg.id`, so a nested declarer
        // (`@opentelemetry/sdk-logs/@opentelemetry/resources`, locked 2.8.0)
        // was located at the first bare hit for `@opentelemetry/resources` —
        // the 2.10.0 copy, the copy of the entry just shed — and its
        // core@2.10.0 judged against the bare lock's 2.8.0. See walkInstallPath
        // for the full measurement; both routes end in an ERROR no `--force`
        // can clear, because the placement is lockfile-determined.
        let located = null;
        let badWalk = null;
        for (const root of bareRoots) {
          const walk = walkInstallPath(root.dir, declarerPath);
          if (walk.ok) {
            located = walk;
            break;
          }
          if (!badWalk && walk.kind !== "absent") badWalk = walk;
        }
        if (located) {
          sites.push({ importer: pkg.key, dir: located.dir });
          continue;
        }
        // Located nowhere as the copy its key names. Three reasons, kept apart:
        // we probed the WRONG copy (not evidence about this key), the site was
        // shed on purpose, or we simply could not look. Folding any of them
        // together would let a wholly-unjudged site list read as an absent
        // dependency in the inconclusive reason.
        if (badWalk) {
          wrongCopy.push(describeBadWalk(pkg.key, badWalk));
          continue;
        }
        const reachableOnlyViaShedRoot = roots.some(
          (root) => rootShadowedByOwnNestedKey(root, entry.id) && resolve(root.dir, pkg.id),
        );
        if (reachableOnlyViaShedRoot) shedThroughNestedRoot.push(pkg.key);
        else unlocatable.push(pkg.key);
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
        ...(wrongCopy.length > 0 ? { wrongCopy } : {}),
        reason:
          `no importer on disk resolves ${entry.id}` +
          (unlocatable.length > 0 ? ` (could not locate: ${unlocatable.join(", ")})` : "") +
          (shedThroughNestedRoot.length > 0
            ? ` (reachable only through a workspace member that nests ${entry.id}: ${shedThroughNestedRoot.join(", ")})`
            : "") +
          (wrongCopy.length > 0
            ? ` (probed the wrong copy — not evidence about this lock key: ${wrongCopy.join("; ")})`
            : ""),
      });
      continue;
    }

    // Site selection above already shed every site entitled to a different
    // version (a nested key is judged only at the importer its install path
    // names; a bare key skips any declarer or member root carrying its own
    // nested key). So the locked version is the ONLY correct answer at a site
    // that survived, and "this version is recorded elsewhere in the lockfile" is
    // no longer an excuse — that excuse is what let the stale bare resolution
    // ride through as a benign `alternate` and never get forced.
    const wrong = observations.filter((o) => o.version !== entry.to);

    // A site excluded as a wrong-copy probe is carried on the verdict even when
    // other sites DID answer. Dropping it silently is how the latent false-clean
    // stayed invisible: four ids read `matched` on this repo's real tree only
    // because a copy the lock key never selected happened to agree.
    if (wrong.length > 0) {
      mismatched.push({
        ...entry,
        ...(wrongCopy.length > 0 ? { wrongCopy } : {}),
        expected: entry.to,
        found: [...new Set(wrong.map((o) => o.version))],
        importers: [...new Set(wrong.map((o) => o.importer))],
        paths: [...new Set(wrong.map((o) => o.path).filter(Boolean))],
      });
    } else {
      matched.push({
        ...entry,
        ...(wrongCopy.length > 0 ? { wrongCopy } : {}),
        importers: [...new Set(observations.map((o) => o.importer))],
      });
    }
  }

  return {
    conclusive: true,
    reason: null,
    checked: change.entries.length,
    matched,
    mismatched,
    inconclusive,
  };
}
