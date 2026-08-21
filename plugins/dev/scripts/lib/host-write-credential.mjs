// host-write-credential.mjs — CTL-2045 §1. What CLASS of credential is this host
// trying to write to Catalyst Cloud with?
//
// ⛔ THE INCIDENT THIS EXISTS FOR. mini-2's 2026-08-18 reinstall provisioned the
// tenant-wide `ADMIN_TOKEN` as the host's write credential instead of a per-host org
// key. The cloud's agent routes correctly refuse an admin bearer for writes, so every
// cross-host claim 403'd and the board froze from ~15:00 CT. ⚠️ The host looked healthy
// the entire time — `catalyst doctor` passed, the daemons ran, the heartbeat was fresh,
// and the local write ledger read `2` with ZERO refusals, because nothing ever got far
// enough to be refused locally. Only CTL-2033's discriminated claim result named it, and
// only after it shipped at 19:46 — four hours in.
//
// ══════════════════════════════════════════════════════════════════════════════════════
// ⭐ POSITIVE ALLOW-LIST, NEVER A BLACKLIST. Implement the ticket's §2, not its title.
// ══════════════════════════════════════════════════════════════════════════════════════
//
// The ticket is titled "refuse an admin bearer". Implementing THAT — a blacklist of known
// -bad shapes — reintroduces the hole one credential over. Measured (@backend BE-12):
// **a bare `sk_…` WorkOS key is also accepted by the cloud** and is also not per-host
// bound. A blacklist of "ADMIN_TOKEN-shaped things" passes it; an allow-list of
// `ctc_acct_` refuses it for free, and refuses the next unknown class too.
//
// ⛔ AND DO NOT GATE ON LENGTH. mini's key is 58 chars and the admin bearer is 64, so a
// `length != 64` check would have caught this incident — and would be wrong. 58-vs-64 is
// an observation about two samples on one day, not a contract; a length check passes
// silently until the format changes, which is a failure in the dangerous direction. The
// issuer defines a PREFIX, and the prefix is what we gate on. From the cloud's own
// validator:
//
//     for (const [type, prefix] of [["organization", "ctc_acct_"], ["user", "ctc_user_"]])
//       if (value.startsWith(prefix)) { … }
//
// ── ⚠️ WHAT THIS CANNOT TELL YOU ────────────────────────────────────────────────────
// A shape check is a PROXY. It would have caught this incident and it will catch the next
// mis-provisioned class, but it cannot see a well-shaped key with the wrong grants, the
// wrong tenant, or the wrong endpoint — all three of which were live hypotheses that
// night. That is why CTL-2045 §2 pairs it with an authenticated preflight against the
// `/agent/*` route family (setup-catalyst.sh's `validate_cloud_agent_binding`), which
// tests the CAPABILITY rather than the shape. Neither half replaces the other.
//
// Zero-import leaf on purpose: `catalyst doctor` runs under bare Node and must be able to
// import this without pulling in a bun:sqlite graph, and the bash mirror
// (lib/catalyst-host-write-credential.sh) is held byte-honest against it by
// __tests__/host-write-credential-parity.test.sh over a SHARED fixture table.

/** The one shape a host write credential may have: a per-host ORGANIZATION key. */
export const HOST_WRITE_CREDENTIAL_PREFIX = "ctc_acct_";

/** Recognized-but-wrong: a USER key. Bound to a person, not to this host. */
export const USER_CREDENTIAL_PREFIX = "ctc_user_";

/**
 * classifyHostWriteCredential(token) -> { verdict, shape, detail }
 *
 * verdict is one of:
 *   "org-key"      — ✅ the only accepted class
 *   "user-key"     — recognized vendor shape, WRONG class (not per-host bound)
 *   "raw-issuer"   — a bare `sk_…`; accepted by the cloud, NOT per-host bound (BE-12)
 *   "unrecognized" — no recognized prefix at all (the ADMIN_TOKEN arm of the incident)
 *   "absent"       — empty/missing
 *
 * ⛔ `shape` is SAFE TO PRINT and the value is NOT. It carries the recognized prefix (or
 * an explicit "no recognized prefix") plus the length — never any bytes of the secret
 * body. Every caller renders `shape`; no caller may render the token. Echoing "what I
 * got" is the whole point of the refusal message, and it is exactly where a credential
 * leaks into a terminal, a CI log, or a support paste if the shape is not pre-redacted
 * here, at the one place that has the token.
 */
export function classifyHostWriteCredential(token) {
  const raw = typeof token === "string" ? token : "";
  const len = raw.length;

  if (len === 0) {
    return {
      verdict: "absent",
      shape: "<empty>",
      detail: "no credential supplied",
    };
  }

  if (raw.startsWith(HOST_WRITE_CREDENTIAL_PREFIX)) {
    return {
      verdict: "org-key",
      shape: `${HOST_WRITE_CREDENTIAL_PREFIX}… (len ${len})`,
      detail: "per-host organization key",
    };
  }

  if (raw.startsWith(USER_CREDENTIAL_PREFIX)) {
    return {
      verdict: "user-key",
      shape: `${USER_CREDENTIAL_PREFIX}… (len ${len})`,
      detail:
        "a USER key — bound to a person, not to this host; the cloud derives no per-host binding from it",
    };
  }

  // ⚠️ BE-12: the cloud ACCEPTS a bare `sk_…`, so this arm is not academic. Named
  // separately from "unrecognized" because the operator remediation differs — a raw
  // issuer key means someone pasted the upstream secret instead of minting a host key.
  if (raw.startsWith("sk_")) {
    return {
      verdict: "raw-issuer",
      shape: `sk_… (len ${len})`,
      detail:
        "a RAW issuer key — the cloud accepts it but derives no per-host binding, so every claim write is refused",
    };
  }

  return {
    verdict: "unrecognized",
    shape: `<no recognized prefix> (len ${len})`,
    detail:
      "no recognized Catalyst Cloud key prefix — this is the shape the tenant-wide ADMIN_TOKEN presents",
  };
}

/** The one predicate every caller gates on. Anything that is not an org key is refused. */
export function isHostWriteCredential(token) {
  return classifyHostWriteCredential(token).verdict === "org-key";
}
