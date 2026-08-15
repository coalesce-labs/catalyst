// cloud-sync-schema-identity.mjs — CTL-1869, the SENDING half of CTC-471's
// schema-skew detection, for the replica the fleet ACTUALLY RUNS.
//
// ── THE GAP ─────────────────────────────────────────────────────────────────
// CTC-471 shipped the receiving half: the Mirror DO reads `?schema_tail=` and
// `?schema_count=` off the connect URL and classifies a consumer as
// current / behind / ahead / unrecognized / unreported
// (catalyst-cloud apps/mirror/src/do/ws.ts). CTC-487 / PR #435 shipped a sender —
// but for `apps/host-sync`, which NO REAL HOST RUNS. The live
// `ai.coalesce.catalyst-cloud-sync` daemon runs cloud-sync.mjs in THIS repo,
// which constructs `CatalystReplica` directly from `@catalyst-cloud/sdk/node`.
//
// Measured 2026-08-15: all 3 connected replicas report `schema_skew: unreported`.
// The feature existed on both ends of a pipe nothing used.
//
// ── WHY THE LOADED BUNDLE, NOT A VERSION STRING ─────────────────────────────
// From the upstream module's own header: a host ran `@catalyst-cloud/schema@0.1.3`
// for 21+ days while 0.1.5 was published, silently dropping every column added
// since — and reported healthy the whole time, because the replica's migration
// tail agreed with the INSTALLED bundle's tail. Nothing compared either to the
// hub's. A version string cannot answer this: the lockfile pins a resolution not
// a range, a nested node_modules shadows the root install, and a daemon holds old
// code in memory until restart. Every one of those is a gap between LOCKED and
// LOADED — the same shape as CTL-1831 (bun won't relink a transitive move) and
// CTL-1659 (installed-but-unloaded cloud-sync deps) in this repo. Three
// instances across two repos is a pattern, not a coincidence.
//
// So the value reported here is read off the schema instance reached THROUGH the
// same SDK entry `cloud-sync.mjs` builds its replica from — see the resolution note
// below, which is the difference between naming the bundle that applies and naming
// whichever copy this file happens to sit next to.

// ── WHY THIS RESOLVES THROUGH THE SDK, NOT BY BARE SPECIFIER (Codex P1, round 1) ──
// The first cut of this file did `import { loadedSchemaIdentity } from
// "@catalyst-cloud/schema"` and claimed, in the header above, that the value came
// from "the same module graph that will do the applying". It did not — and the gap
// was the very LOCKED-vs-LOADED defect this ticket exists to close.
//
// `cloud-sync.mjs` builds its replica from `@catalyst-cloud/sdk/node`, so the
// bundle that MIGRATES AND APPLIES is whatever the SDK resolves. A bare specifier
// resolves from THIS file instead, and under bun's isolated linker those are
// different copies. Measured on this checkout, both instruments agreeing:
//
//   replica-used (via @catalyst-cloud/sdk/node) → schema 0.1.5 → 0015_brainy_lady_ursula, 16
//   bare specifier (workspace root)             → schema 0.1.9 → 0018_brainy_clint_barton, 19
//
// So the shipped version advertised 19 migrations for a replica applying 16: three
// behind, reported as CURRENT. A skew detector that manufactures a false `current`
// is worse than the `unreported` it replaced. This is CTL-1831's rule restated —
// "the discriminator is the IMPORTING package's resolved dependency, not the
// hoisted top-level copy" — which this repo had already written down.
//
// Resolving through the SDK also removes the undeclared bare import that Codex's
// second P1 flagged: under the versioned plugin-cache layout the repository-root
// manifest is absent and `execution-core/package.json` declares
// `@catalyst-cloud/sdk` but never `@catalyst-cloud/schema`, so the bare specifier
// could fail at module load and take the replica down with it. We now reach the
// schema only through a dependency that IS declared.
//
// ⚠️ `loadedSchemaIdentity()` does not exist in every schema version — 0.1.5, the
// one the SDK actually resolves here, does not export it (its 27 exports include
// `MIRROR_MIGRATIONS` but no accessor). Calling it unconditionally is what forced
// the bare import in the first place. Both versions carry the same underlying
// `MIRROR_MIGRATIONS.journal.entries`, and on 0.1.9 the accessor's output is
// exactly the journal-derived value, so deriving from the journal is equivalent
// where the accessor exists and is the only option where it does not.
import { createRequire } from "node:module";

/**
 * The honest degenerate state: "this process loaded no bundle it can name".
 * Resolves to `unreported` at the hub — never a half-filled identity.
 */
const UNREPORTED = Object.freeze({ tail: null, count: 0 });

/** Accept an identity only if it is affirmatively well-formed; else null. */
function normalizeIdentity(id) {
  const tail = id?.tail;
  if (typeof tail !== "string" || tail === "") return null;
  const count = Number.isInteger(id?.count) && id.count >= 0 ? id.count : 0;
  return { tail, count };
}

/**
 * Derive `{tail, count}` from a schema module instance.
 *
 * Order matters: prefer the module's OWN accessor when it has one (forward-compat
 * for versions that add it), then fall back to the journal both versions carry.
 * A malformed accessor result does NOT short-circuit to `unreported` — it falls
 * through to the journal, because "present but wrong" and "absent" are different
 * verdicts and only the second one is a reason to give up.
 */
export function schemaIdentityOf(mod) {
  if (typeof mod?.loadedSchemaIdentity === "function") {
    try {
      const viaAccessor = normalizeIdentity(mod.loadedSchemaIdentity());
      if (viaAccessor) return viaAccessor;
    } catch {
      // fall through to the journal
    }
  }
  const entries = mod?.MIRROR_MIGRATIONS?.journal?.entries;
  if (Array.isArray(entries) && entries.length > 0) {
    return normalizeIdentity({ tail: entries.at(-1)?.tag, count: entries.length }) ?? UNREPORTED;
  }
  return UNREPORTED;
}

/**
 * The identity of the schema bundle THE REPLICA WILL APPLY WITH — resolved through
 * the SDK entry `cloud-sync.mjs` itself imports, so the reported bundle and the
 * applying bundle cannot diverge.
 *
 * Fail-safe by construction: any resolution or load failure yields `UNREPORTED`
 * rather than throwing. This runs on the connect path of the daemon that keeps the
 * replica alive; a skew REPORT must never be able to prevent replication.
 */
export function replicaSchemaIdentity({
  requireFn = createRequire(import.meta.url),
  sdkSpecifier = "@catalyst-cloud/sdk/node",
} = {}) {
  try {
    const sdkEntry = requireFn.resolve(sdkSpecifier);
    return schemaIdentityOf(createRequire(sdkEntry)("@catalyst-cloud/schema"));
  } catch {
    return UNREPORTED;
  }
}

/**
 * Append `schema_tail` / `schema_count` to a fully-built `/connect` URL.
 *
 * ⛔ ALL-OR-NOTHING, mirroring the cloud's `parseSchemaIdentity`. A null tail means
 * "this process loaded no bundle" — an honest degenerate state that must resolve to
 * `unreported`, NOT to a half-filled identity the hub could misread as `current`.
 * A null tail therefore sends NEITHER param and the socket opens on the unmodified
 * URL. There is no partial report.
 *
 * Uses `URL.searchParams` rather than string concatenation so a tail carrying a
 * URL-reserved character is percent-encoded and the existing query — which
 * includes `account` and, for token auth, `token` — is preserved verbatim.
 */
export function appendSchemaIdentity(rawUrl, id) {
  if (!id || id.tail === null || id.tail === undefined) return rawUrl;
  const u = new URL(rawUrl);
  u.searchParams.set("schema_tail", String(id.tail));
  u.searchParams.set("schema_count", String(id.count));
  return u.toString();
}

/**
 * A `wsFactory` that replicates the SDK's own default, on a URL carrying our
 * loaded schema identity.
 *
 * ⚠️ Deliberately NOT a port of PR #435's socket adapter. That package compiles
 * with `@types/node`, whose `WebSocket` handler properties are not
 * type-assignable to the SDK's structural `WebSocketLike`, so it bridges the two
 * surfaces through `addEventListener`. This module is plain `.mjs` — there is no
 * type surface to reconcile, and the SDK's own untyped-JS `defaultWsFactory` does
 * exactly `new globalThis.WebSocket(url)`. Copying the adapter here would be
 * carrying a workaround for a problem this file does not have.
 *
 * ⚠️ The URL carries the auth token. It must never be logged, in this factory or
 * anywhere downstream — cloud-sync.mjs's own note is that the token value "flows
 * ONLY here".
 *
 * Runs per (re)connect, so the reported identity tracks the loaded bundle across
 * reconnects and restarts rather than being frozen at process start.
 */
export function createSchemaReportingWsFactory(identity = replicaSchemaIdentity()) {
  return (url) => {
    const Ctor = globalThis.WebSocket;
    if (!Ctor) {
      throw new Error(
        "global WebSocket unavailable; needs Bun or Node >= 22 (matches the SDK's defaultWsFactory)"
      );
    }
    return new Ctor(appendSchemaIdentity(url, identity));
  };
}
