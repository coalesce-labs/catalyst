#!/usr/bin/env node
// identity-report.mjs — CTL-2300. The four identities every Catalyst agent tool silently
// assumed, resolved out loud.
//
// ## Why this exists
//
// The setup checks that already ship test the HOST INSTALL — binaries on PATH, thoughts
// symlinks, a replica that is fresh. None of them tests WHOSE workspace the tools are
// about to write into. A customer with a perfect host install and no `.catalyst/config.json`
// got `tenant-0`, the fleet owner's Linear user id, team `PROJ` and a retired API host, and
// nothing failed until a write landed in the wrong place or was refused by the tenant fence.
//
// Every one of those four is an IDENTITY, and an identity that resolves to a plausible
// wrong value fails silently. So this prints one line per slot, saying which rung answered
// — or that nothing did.
//
// ## Output contract
//
// One line per slot on stdout, `slot<TAB>status<TAB>detail`:
//
//   tenant   ok|unresolved   <account id> (env|layer1|layer2)  |  <what to set>
//   human    ok|unresolved   …
//   team     ok|unresolved   …
//   host     ok|unresolved   …
//
// Machine-readable on purpose: `check-project-setup.sh` turns every `unresolved` line into
// a named warning without re-deriving any of the ladders, and `--json` gives the same
// answer to anything that would rather parse an object.
//
// Exit code is ALWAYS 0. This is a reporter, not a gate: a repo that has not configured a
// tenant is a repo mid-setup, and a checkup that refuses to finish tells the operator less
// than one that lists what is missing.

import { resolveAskHuman, resolveAskTeam } from "./lib/tenant-identity.mjs";
import {
  BASE_URL_CONFIG_PATH,
  CANONICAL_CLOUD_HOST,
  isRetiredCloudHost,
  resolveCloudBaseUrl,
} from "./lib/cloud-facts.mjs";

/**
 * The tenant/account id.
 *
 * ⛔ NO `tenant-0` FALLBACK, AND THAT IS THE POINT. `lib/replica-path.mjs` and
 * `setup-catalyst.sh` both default to it, so a customer host is stamped with the fleet
 * owner's account before it has said anything. There is no cloud route a key holder can
 * ask "which account am I?" yet (CTC-493), so the honest answer here is `unresolved` with
 * the two places an operator can declare it — not a guess that reads like a fact.
 */
export function resolveTenantAccount({ env = process.env } = {}) {
  const declared = (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
  const fromEnv = declared(env?.CATALYST_CLOUD_ACCOUNT);
  if (fromEnv) return { ok: true, account: fromEnv, source: "env" };
  return {
    ok: false,
    message:
      "no cloud account declared. Export CATALYST_CLOUD_ACCOUNT, or set it in the host's " +
      "cloud-sync env. Nothing here defaults to tenant-0: on a customer host that is the " +
      "fleet owner's account, and the mirror's tenant fence refuses the write long after " +
      "the tools have decided it was fine.",
  };
}

/** Resolve all four, in the order a session needs them. Pure — takes its whole world in. */
export function resolveIdentities({ env = process.env, layer1ConfigPath, layer2ConfigPath } = {}) {
  const tenant = resolveTenantAccount({ env });
  const human = resolveAskHuman({ env, layer1ConfigPath, layer2ConfigPath });
  const team = resolveAskTeam({ env, layer1ConfigPath });
  const host = resolveCloudBaseUrl({ env, layer1ConfigPath, layer2ConfigPath });

  return [
    {
      slot: "tenant",
      ok: tenant.ok,
      detail: tenant.ok ? `${tenant.account} (${tenant.source})` : tenant.message,
    },
    {
      slot: "human",
      ok: human.ok,
      detail: human.ok
        ? `${human.name ?? "unnamed"} <${human.humanId}> (${human.source})`
        : human.message,
    },
    {
      slot: "team",
      ok: team.ok,
      detail: team.ok ? `${team.team} (${team.source})` : team.message,
    },
    {
      slot: "host",
      // ⚠️ A host resolved from the DEFAULT rung is `ok` — the canonical host is a correct
      // answer, not a missing one (see cloud-facts.mjs on why this ladder keeps a default
      // where the human's does not). What is NOT ok is a retired host, which is what the
      // resolver's own failure means here.
      ok: host.ok,
      detail: host.ok
        ? `${host.baseUrl} (${host.source})`
        : `${host.message} Canonical: https://${CANONICAL_CLOUD_HOST}/api/v1 (${BASE_URL_CONFIG_PATH}).`,
    },
  ];
}

export function formatIdentities(rows) {
  return rows.map((r) => `${r.slot}\t${r.ok ? "ok" : "unresolved"}\t${r.detail}`).join("\n");
}

// ── entry point ────────────────────────────────────────────────────────────────────────
// Guarded the way every other dual-purpose module here is, so importing it for a test runs
// nothing.
const invokedDirectly =
  typeof process.argv[1] === "string" && process.argv[1].endsWith("identity-report.mjs");

if (invokedDirectly) {
  const rows = resolveIdentities({});
  if (process.argv.includes("--json")) {
    process.stdout.write(JSON.stringify(rows) + "\n");
  } else {
    process.stdout.write(formatIdentities(rows) + "\n");
  }
  process.exit(0);
}

export { isRetiredCloudHost };
