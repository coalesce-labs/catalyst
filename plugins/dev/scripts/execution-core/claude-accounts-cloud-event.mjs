// claude-accounts-cloud-event.mjs — CTL-1991. Event-name constants for the
// cloud-delivery materialize pair. Imported by namespace-parity.test.mjs (the
// CTL-1659/CTL-1889 discipline — never re-type a literal when the constant
// can be imported, so a rename cannot leave this contract asserting a name
// nothing emits).
//
// The `catalyst.claude-accounts.*` prefix is UNPROTECTED under the CTL-1142
// namespace contract (not filter.* / broker.daemon.* / session.heartbeat /
// phase.<name>.<terminal>) and routes through shouldSkipEvent normally.
//
// Two names, not one name plus a flag: otel-forward strips body.payload
// off-machine, so an alert on the materialized event must be able to select
// it by attributes alone — a payload field is insufficient.

export const CLAUDE_ACCOUNTS_CLOUD_MATERIALIZED_EVENT =
  "catalyst.claude-accounts.cloud_materialized";

export const CLAUDE_ACCOUNTS_CLOUD_WOULD_MATERIALIZE_EVENT =
  "catalyst.claude-accounts.cloud_would_materialize";
