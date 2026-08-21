// cloud-sync-account.mjs — CTL-1893 / sdk 0.8.7 replica tenant fence.
//
// Two pure pieces extracted from the script-shaped `cloud-sync.mjs` so they are
// unit-testable without booting a writer — the same reason `depSkewEventEnvelope` lives
// outside it.
//
// ## Why provenance is a separate fact from the account
//
// The SDK's tenant fence stamps `sync_meta.account` on first open and refuses a
// mismatched one. Its refusal rule is:
//
//     refuse when   stored.source === "declared" || mySource !== "declared"
//
// so the truncate + cursor-drop + cold-reseed TRANSITION happens on exactly one edge:
// a stored **default** meeting a configured **declared**. Everything else refuses,
// deliberately — two disagreeing defaults give no basis to prefer either account, and
// therefore none to DELETE either one's rows.
//
// ⛔ The consequence for us: if we pass only `account`, the SDK applies its
// `accountSource: "default"` fallback, and an operator who explicitly sets
// CATALYST_CLOUD_ACCOUNT is judged default-vs-default → REFUSED. The writer would fail to
// start on the very reconfiguration the operator just performed. Passing provenance is
// what makes that edge reachable.

/**
 * Resolve the account and whether it was DECLARED or DEFAULTED.
 *
 * ⚠️ An empty string is NOT a declaration. `CATALYST_CLOUD_ACCOUNT=""` is indistinguishable
 * from unset in intent, and treating it as declared would stamp a permanent assertion off
 * a value nobody chose — the precise failure this whole contract exists to avoid.
 */
export function resolveAccountProvenance(env = process.env, defaultAccount = "tenant-0") {
  const declared = env?.CATALYST_CLOUD_ACCOUNT || "";
  // ⛔ THE LAUNCHER DEFAULTS THE ACCOUNT, so env-presence alone is NOT provenance.
  // `cloud-sync/launch.sh` runs `CATALYST_CLOUD_ACCOUNT="${CATALYST_CLOUD_ACCOUNT:-tenant-0}"`,
  // which makes the var always-set on the shipped launchd path. Deriving provenance from
  // presence there returns "declared" for EVERY host, stamping every default replica as a
  // declaration nobody made — the precise failure this contract exists to prevent, one
  // layer further down. The launcher therefore captures the distinction BEFORE its own
  // fallback and passes it here explicitly.
  //
  // ⚠️ Only the two known values are honoured, and anything else degrades to "default".
  // An unrecognised marker must never be read as "declared": a declared stamp is permanent
  // and refuses later transitions, while a default stamp stays recoverable. When the two
  // directions cost different things, an unknown lands on the recoverable one.
  const marker = env?.CATALYST_CLOUD_ACCOUNT_SOURCE;
  const markerPresent = typeof marker === "string" && marker !== "";
  // A PRESENT but unrecognised marker degrades to "default" — it does NOT fall through to
  // presence-derivation. Falling through would re-open the whole bug on the launchd path,
  // where the account is always set: a typo'd or truncated marker would derive "declared"
  // for every host, which is exactly the state this marker exists to prevent. A marker that
  // is present at all means something tried to tell us; if we cannot read it, the
  // recoverable answer is the only safe one.
  const accountSource = markerPresent
    ? marker === "declared"
      ? "declared"
      : "default"
    : declared
      ? "declared"
      : "default";
  return {
    account: declared || defaultAccount,
    accountSource,
    declared: accountSource === "declared",
  };
}

/**
 * Is this error the SDK's permanent tenant-fence refusal?
 *
 * ⛔ Matched by `name`, never `instanceof`. The SDK can legitimately be present as more
 * than one copy under bun's isolated linker, and a cross-copy `instanceof` is FALSE — which
 * would silently route a permanent config fault back onto the retry-forever path. Name
 * matching fails in the safe direction: the cost of a false positive is a writer that stays
 * down loudly, the cost of a false negative is an infinite relaunch loop on a fault no
 * restart can clear.
 */
export function isAccountMismatchError(err) {
  return err?.name === "ReplicaAccountMismatchError";
}

/**
 * The v2 envelope for a permanent, non-retryable refusal — same shape as the writer-idle
 * event, ERROR severity because no restart clears it.
 *
 * The writer is about to stay DOWN, so this is the only structured record that will say so;
 * it rides the unified event log rather than the replica this process just refused to open.
 */
export function accountMismatchEnvelope({
  host,
  dbPath,
  storedAccount,
  configuredAccount,
  configuredSource,
  ts,
  id,
  traceId,
  spanId,
  resource,
}) {
  return {
    ts,
    id,
    observedTs: ts,
    severityText: "ERROR",
    severityNumber: 17,
    traceId,
    spanId,
    resource,
    attributes: {
      "event.name": "catalyst.replica.account_mismatch",
      "event.entity": "replica",
      "event.action": "account_mismatch",
      "event.label": host,
      host,
      db_path: dbPath,
      stored_account: storedAccount ?? null,
      configured_account: configuredAccount,
      configured_source: configuredSource,
    },
    body: {
      message:
        `cloud-sync refusing to start: replica at ${dbPath} is stamped for ` +
        `${storedAccount ?? "(unknown)"}, configured for ${configuredAccount} ` +
        `(${configuredSource}). Permanent config fault — writer staying down.`,
    },
  };
}
