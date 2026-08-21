// replica-path.mjs — CTL-1893: the replica path derives from the ACCOUNT.
//
// ## What this fixes
//
// `cloud-sync.mjs` resolves the account and the database path INDEPENDENTLY:
//
//     const { account } = resolveAccountProvenance(process.env, DEFAULT_ACCOUNT);
//     const dbPath = getReplicaDbPath();   // ← no account dimension, anywhere
//
// `getReplicaDbPath()` is `CATALYST_REPLICA_DB || <catalystDir>/catalyst-replica.db`.
// So a second `cloud-sync` started with a different `CATALYST_CLOUD_ACCOUNT` targets the
// SAME file, and the writer lock at `<dbPath>.writer.lock` makes the two either refuse or
// fight over one tenant-mixed database. `account` reaches the writer guard's `ownerKey`;
// it never reaches the path that guard is guarding.
//
// ## The one design decision worth reading: the DEFAULT account keeps the LEGACY path
//
// `tenant-0` resolves to `<catalystDir>/catalyst-replica.db` — the existing file — and
// only a NON-default account derives `<catalystDir>/replicas/<account>.db`.
//
// This is deliberate and it is the whole reason this change is safe to land incrementally.
// Deriving `replicas/tenant-0.db` for everyone would point every host's writer at a NEW,
// EMPTY file: a fleet-wide cold re-seed, and — until all 14 readers move in the same
// instant — every reader still on the old path silently serving a frozen mirror. Measured
// on the fleet 2026-08-18: both minis run `CATALYST_CLOUD_ACCOUNT=tenant-0` with
// `CATALYST_REPLICA_DB` UNSET, and both replicas are already stamped
// `sync_meta.account = tenant-0`. Under the rule above, nothing on those hosts moves.
//
// The ticket's Gherkin still holds: two accounts on one host resolve to two different
// files, each derived from its account, each with its own lock (the lock is
// `dbPath + '.writer.lock'`, so it follows the path for free — see cli.ts:140 upstream).
//
// ## What guards a wrong path, and why it is NOT this module
//
// The ticket proposed a host-side refusal — "an explicit override that disagrees with the
// derived path is refused" — because at filing time nothing checked that the database a
// writer opened belonged to the account it was syncing. **That guard has since shipped
// upstream** (CTC-582 / catalyst-cloud-sdk#18, in SDK 0.8.7; the fleet pins 0.8.14): the
// SDK stamps `sync_meta.account` on first open and refuses a mismatched one with
// `ReplicaAccountMismatchError`, which `cloud-sync.mjs` already handles by name. Verified
// present on the live fleet: `sync_meta` carries `account=tenant-0` and
// `account_source=default` on mini and on the laptop.
//
// So this module REPORTS a disagreement (`overrideDisagrees`) rather than refusing on its
// own. Two reasons:
//
//   1. Refusing here would break `CATALYST_REPLICA_DB` as a redirection mechanism, which
//      31 call sites (mostly tests) depend on and which no production host uses.
//   2. The writer half is already fenced upstream by a stamp — a strictly better guard
//      than a path comparison, because it survives two hosts pointed at one file, which a
//      path check cannot see. The half that is still UNGUARDED is the READER: a reader
//      has no stamp check at all, which is the "silently reads another tenant's replica"
//      case. That belongs with the caller migration, not here.
//
// ⚠️ `overrideDisagrees()` therefore has NO production caller in this increment, by
// design. It is the predicate the writer gates on when the callers are migrated. Saying so
// out loud because an unwired check that looks wired is how this repo has shipped
// guarantees that could not fire.
//
// ## Zero-import leaf
//
// No imports at all — not even `node:path`. `catalyst doctor` loads this class of module
// under bare Node, and the bash mirror (`lib/catalyst-replica-path.sh`) has to reproduce
// the answer byte-for-byte, which is far easier against explicit string joins than against
// `path.resolve`'s normalisation. Paths are joined the way the existing bash helper joins
// them (`${CATALYST_DIR:-$HOME/catalyst}/catalyst-replica.db`), so the two agree by
// construction rather than by review. Held there by
// `__tests__/replica-path-parity.test.sh`.

/** The account a host serves when it declares none. Mirrors cloud-sync.mjs. */
export const DEFAULT_ACCOUNT = "tenant-0";

// An account name becomes a PATH SEGMENT, so it must not be able to escape the directory
// it is placed in. Leading character is constrained separately so a name can never start
// with `.` (a dotfile, or the `..` traversal) or `-` (which reads as a flag to any CLI
// that later handles it). Everything else is the conservative id alphabet.
const ACCOUNT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Is this a usable account name — i.e. one that can safely become a path segment?
 * @param {unknown} account
 * @returns {boolean}
 */
export function isAccountName(account) {
  return typeof account === "string" && ACCOUNT_RE.test(account) && !account.includes("..");
}

// catalystDir — the same ladder as config.mjs's catalystDir() and the bash helper's
// `${CATALYST_DIR:-${HOME:-}/catalyst}`. An empty CATALYST_DIR is not a declaration.
function catalystDir(env) {
  const dir = env?.CATALYST_DIR;
  if (typeof dir === "string" && dir !== "") return dir;
  const home = typeof env?.HOME === "string" ? env.HOME : "";
  return `${home}/catalyst`;
}

/**
 * Resolve the replica database path for ONE account.
 *
 * Never throws and never guesses: an absent or unusable account yields a NAMED failure
 * with no `path` at all, so a mis-wired caller cannot read another tenant's rows and call
 * it a default.
 *
 * @param {{account?: unknown, env?: Record<string, string|undefined>}} [opts]
 * @returns {{ok: true, path: string, derived: string, account: string,
 *            source: "override"|"override-agrees"|"derived"|"derived-default",
 *            overrideDisagrees: boolean}
 *          | {ok: false, reason: "account-absent"|"account-invalid", message: string,
 *             account: unknown, path?: undefined}}
 */
export function resolveReplicaPath({ account, env = process.env } = {}) {
  if (typeof account !== "string" || account.trim() === "") {
    return {
      ok: false,
      reason: "account-absent",
      account,
      message:
        "replica path: no account named. Pass the resolved cloud account (e.g. from " +
        "resolveAccountProvenance); this resolver will not default to " +
        `${DEFAULT_ACCOUNT} on your behalf.`,
    };
  }
  if (!isAccountName(account)) {
    return {
      ok: false,
      reason: "account-invalid",
      account,
      message:
        `replica path: account ${JSON.stringify(account)} is not a usable path segment ` +
        "(allowed: alphanumeric start, then letters, digits, dot, underscore, hyphen; no " +
        "separators and no '..').",
    };
  }

  const dir = catalystDir(env);
  const derived =
    account === DEFAULT_ACCOUNT
      ? `${dir}/catalyst-replica.db`
      : `${dir}/replicas/${account}.db`;

  const override = env?.CATALYST_REPLICA_DB;
  if (typeof override === "string" && override !== "") {
    const agrees = override === derived;
    return {
      ok: true,
      path: override,
      derived,
      account,
      source: agrees ? "override-agrees" : "override",
      overrideDisagrees: !agrees,
    };
  }

  return {
    ok: true,
    path: derived,
    derived,
    account,
    source: account === DEFAULT_ACCOUNT ? "derived-default" : "derived",
    overrideDisagrees: false,
  };
}

/**
 * The refusal predicate for a WRITER: an explicit override pointing somewhere other than
 * this account's derived path. A named failure is NOT a disagreement — the caller handles
 * that as its own case, because "no account" and "wrong path" want different messages.
 *
 * ⚠️ Unwired in increment 1, by design — see this module's header.
 *
 * @param {ReturnType<typeof resolveReplicaPath>} result
 * @returns {boolean}
 */
export function overrideDisagrees(result) {
  return result?.ok === true && result.overrideDisagrees === true;
}
