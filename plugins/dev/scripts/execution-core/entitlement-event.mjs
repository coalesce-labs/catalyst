// entitlement-event.mjs — CTL-1785. The entitlement event-name registry.
//
// v3 bare-name events (matches the `phase.*` observability style): the emitted
// name is `<base>.<host>`, e.g. `entitlement.would-shed.mini-2`. The `entitlement.`
// prefix is UNPROTECTED under the CTL-1142 namespace contract (it routes through
// shouldSkipEvent normally — no isBrokerProtectedName collision), asserted in
// broker/namespace-parity.test.mjs.
//
// Exported as constants (not re-typed literals at each call site) so a rename can
// never leave the namespace-parity contract asserting over a name nothing emits —
// the same discipline CTL-1659/CTL-1889/CTL-2076 use.

// entitlement.would-shed.<host> — shadow mode: this rostered host lacks
// entitlement and WOULD be shed in enforce, but the roster is unchanged.
export const ENTITLEMENT_WOULD_SHED = "entitlement.would-shed";

// entitlement.shed.<host> — enforce mode: this host was actually removed from the
// entitlement roster used by dispatch/recovery.
export const ENTITLEMENT_SHED = "entitlement.shed";

// entitlement.restored.<host> — a previously-shed host regained entitlement.
export const ENTITLEMENT_RESTORED = "entitlement.restored";

export const ENTITLEMENT_EVENT_NAMES = Object.freeze([
  ENTITLEMENT_WOULD_SHED,
  ENTITLEMENT_SHED,
  ENTITLEMENT_RESTORED,
]);
