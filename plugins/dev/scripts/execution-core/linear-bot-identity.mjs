// linear-bot-identity.mjs — CTL-1892.
//
// The self-echo guard's identity set, made ROTATION-DURABLE.
//
// ## The defect this exists to close
//
// `readLinearBotUserIds` builds its set from the CURRENTLY CONFIGURED app-actor ids.
// That set is point-in-time, so a rotation REPLACES it rather than extending it, and
// from the moment a new app-actor starts writing until every host's config names it,
// the fleet's own echoes are not recognised as its own — it dispatches on its own
// writes as if a third party had moved the board. Nothing errors; the symptom is
// indistinguishable from ordinary activity.
//
// Measured on this fleet: two Linear actors both named "Catalyst Orchestrator" —
// `f51bc697…` (handle `catalystorchestrator`, 2,241 writes, 2026-06-05 → 2026-08-10)
// and `ba2989f1…` (handle `catalystorchestrator2`, from 2026-08-10). Linear's `2`
// suffix on a taken handle plus the same-day handoff makes it a re-mint, not a stray
// process. Only the second is named by any config, so every echo of the first read as
// a third-party change.
//
// ## The mechanism
//
// A durable, append-only, per-host ledger of every identity THIS FLEET HAS WRITTEN AS.
// The resolved set is `config ∪ ledger`, so a rotation EXTENDS rather than replaces.
//
// ⛔ ONLY ids the fleet writes as may enter the ledger — i.e. ids read from our own
// config. An identity must never be admitted because it was OBSERVED writing, or a
// third party could get itself suppressed by writing to the board, which inverts the
// guard into a way to hide changes from the fleet. The recording seam takes ids from
// config only, and that is the whole security argument for this file.
//
// ## What this does NOT close
//
// A cross-host propagation window. If host A rotates and writes as NEW while host B's
// config still names OLD, B has never written as NEW and so cannot have it in its
// ledger. Closing that requires the rotation to reach every host's config — which is
// what the cluster config distribution already does. This makes each host's own view
// MONOTONIC; it does not make one host learn another's brand-new identity.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const LEDGER_VERSION = 1;

/**
 * Default ledger location: beside the rest of the host's durable Catalyst state.
 *
 * ⚠️ Resolves CATALYST_DIR **per call**, exactly as `config.mjs` does. Hard-coding
 * `$HOME/catalyst` would make two isolated installations sharing a home share retired
 * identities — each suppressing the other's actors — and would lose persistence
 * entirely on a host whose home is not writable but whose state root is. The env var
 * is also how tests isolate, so a fixed path silently writes to real host state.
 * Deliberately NOT imported from config.mjs: this module stays an import-light leaf
 * (config.mjs pulls the bun:sqlite graph), so the one line is mirrored instead.
 */
export function defaultIdentityLedgerPath(catalystHome) {
  const home = catalystHome || process.env.CATALYST_DIR || join(process.env.HOME || "", "catalyst");
  return join(home, "linear-bot-identities.json");
}

/**
 * Identities this fleet has PROVABLY written as, established by evidence and committed
 * so a host that first runs this code AFTER a rotation still recognises them.
 *
 * ⛔ Without this seed the ledger bootstraps empty while the config already names only
 * the replacement, so a retired actor is never learned and its echoes stay third-party
 * FOREVER — the rollout case, and the exact defect this module exists to close.
 *
 * The bar for adding an entry is the bar met below: same display name, a Linear
 * handle-collision suffix, a same-day handoff with no overlap, and no other config
 * anywhere naming it. "It wrote a lot" is NOT sufficient — an id admitted here can
 * never be dispatched on again.
 */
export const KNOWN_RETIRED_IDENTITIES = Object.freeze([
  {
    id: "f51bc697-c64b-47b8-9fba-a2981fbfe652",
    handle: "catalystorchestrator",
    retiredOn: "2026-08-10",
    supersededBy: "ba2989f1-f250-4273-943c-ca511c66e793", // handle catalystorchestrator2
    evidence:
      "2,241 writes 2026-06-05..2026-08-10 (1,404 state edges, 748 label writes); same display " +
      "name 'Catalyst Orchestrator' as its successor, whose handle carries Linear's collision " +
      "suffix '2'; same-day handoff with no overlap; named by no config, live or backup (CTL-1892)",
  },
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A Linear user id we are willing to treat as an identity. Shape-checked so a
 *  truncated/`null`/numeric value cannot enter the set and silently match nothing —
 *  or worse, match an empty author id. */
export function isPlausibleIdentityId(v) {
  return typeof v === "string" && UUID_RE.test(v);
}

/**
 * Read the ledger. THREE-VALUED — `absent` and `unreadable` are different verdicts.
 *
 * ⚠️ Collapsing them into "empty" is how a corrupt ledger silently degrades into
 * today's point-in-time guard: the rotation window reopens and nothing says so. The
 * caller decides what to do, but it is never allowed to be unable to tell.
 */
export function readIdentityLedger(path) {
  if (!path) return { status: "absent", ids: new Set(), reason: "no-path" };
  if (!existsSync(path)) return { status: "absent", ids: new Set(), reason: "no-file" };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    return { status: "unreadable", ids: new Set(), reason: `parse: ${err?.message ?? "unknown"}` };
  }
  // Shape is validated BEFORE any coercion. `[]`, `null`, and `{identities:"abc"}`
  // all produce an empty set under a permissive read, which is indistinguishable
  // from a healthy empty ledger — the exact false-clean this file refuses.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { status: "unreadable", ids: new Set(), reason: "not-an-object" };
  }
  if (!Array.isArray(parsed.identities)) {
    return { status: "unreadable", ids: new Set(), reason: "identities-not-an-array" };
  }
  const ids = new Set();
  let skipped = 0;
  for (const entry of parsed.identities) {
    const id = typeof entry === "string" ? entry : entry?.id;
    if (isPlausibleIdentityId(id)) ids.add(id);
    else skipped += 1;
  }
  return { status: "ok", ids, skipped, reason: null };
}

/**
 * Record an identity the fleet writes as. Append-only and idempotent.
 *
 * Returns `{ recorded, alreadyKnown, status }`. NEVER throws — a ledger write must
 * not be able to take down the daemon whose echoes it protects.
 */
export function recordIdentity(path, id, { source = "config", now = () => Date.now() } = {}) {
  if (!path) return { recorded: false, alreadyKnown: false, status: "no-path" };
  if (!isPlausibleIdentityId(id)) return { recorded: false, alreadyKnown: false, status: "implausible-id" };

  const existing = readIdentityLedger(path);
  // ⛔ Refuse to write over a ledger we could not READ. Rewriting an unreadable file
  // would DESTROY the retired identities it still holds — turning a transient read
  // problem into the permanent reopening of the rotation window.
  if (existing.status === "unreadable") {
    return { recorded: false, alreadyKnown: false, status: "refused-unreadable", reason: existing.reason };
  }
  if (existing.ids.has(id)) return { recorded: false, alreadyKnown: true, status: "ok" };

  let prior = [];
  if (existing.status === "ok") {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8"));
      if (Array.isArray(raw?.identities)) prior = raw.identities;
    } catch {
      return { recorded: false, alreadyKnown: false, status: "refused-unreadable", reason: "reread-failed" };
    }
  }

  const next = {
    version: LEDGER_VERSION,
    identities: [...prior, { id, source, firstRecordedAt: now() }],
  };
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
    renameSync(tmp, path); // atomic: a concurrent reader sees old or new, never half
  } catch (err) {
    return { recorded: false, alreadyKnown: false, status: "write-failed", reason: err?.message };
  }
  return { recorded: true, alreadyKnown: false, status: "ok" };
}

/**
 * The self-echo identity set: `configIds ∪ ledgerIds`.
 *
 * Fail-open on a bad ledger — the configured ids are still returned, because losing
 * them would suppress NOTHING and turn every one of the fleet's own writes into a
 * dispatch. But the degradation is REPORTED (`ledgerStatus`), never silent: the
 * caller is expected to log it, since "the rotation window is open again" is exactly
 * the condition that has no other symptom.
 */
export function resolveSelfIdentities({ configIds = new Set(), ledgerPath = null } = {}) {
  const ledger = readIdentityLedger(ledgerPath);
  const ids = new Set();
  for (const id of configIds) if (isPlausibleIdentityId(id)) ids.add(id);
  for (const id of ledger.ids) ids.add(id);
  // Seeded regardless of ledger state: a host whose ledger is absent (first run) or
  // unreadable must still recognise a known retired actor, or the rollout case leaves
  // its echoes third-party forever.
  for (const { id } of KNOWN_RETIRED_IDENTITIES) ids.add(id);
  return {
    ids,
    ledgerStatus: ledger.status,
    ledgerReason: ledger.reason ?? null,
    fromLedgerOnly: [...ledger.ids].filter((id) => !configIds.has(id)),
  };
}

/**
 * Record every currently-configured identity, then return the unified set. This is
 * the seam callers use: reading the config is also how the ledger LEARNS, so a
 * rotation extends the set on the first tick after the new id lands in config.
 */
export function syncAndResolveSelfIdentities({ configIds = new Set(), ledgerPath = null, source = "config", now } = {}) {
  const recorded = [];
  const writeFailures = [];
  for (const id of configIds) {
    const r = recordIdentity(ledgerPath, id, { source, now });
    if (r.recorded) recorded.push(id);
    // ⛔ A DISCARDED write failure is invisible: the re-read below reports a
    // healthy-looking `absent` or `ok`, so a read-only dir or a full disk silently
    // costs rotation durability with no symptom until the NEXT rotation — by which
    // time the window is already open. Surface it as its own degradation.
    else if (r.status === "write-failed" || r.status === "refused-unreadable") {
      writeFailures.push({ id, status: r.status, reason: r.reason ?? null });
    }
  }
  const resolved = resolveSelfIdentities({ configIds, ledgerPath });
  // A configured id that is NOT durably on disk is the honest signal of lost
  // durability — independent of why the write failed.
  const notDurable = [...configIds].filter((id) => isPlausibleIdentityId(id) && !readIdentityLedger(ledgerPath).ids.has(id));
  return { ...resolved, recorded, writeFailures, notDurable };
}
