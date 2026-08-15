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
// So the value reported here comes from `loadedSchemaIdentity()`, evaluated in the
// same module graph that will do the applying.

import { loadedSchemaIdentity } from "@catalyst-cloud/schema";

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
export function createSchemaReportingWsFactory(identity = loadedSchemaIdentity()) {
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
