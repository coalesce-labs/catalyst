// event-name.mjs — getEventName, extracted to a dependency-free leaf (CTL-1348).
//
// CTL-336: read the event name from canonical OTel-format events (data in
// `attributes`) as well as legacy flat events (data in top-level `event`), so the
// rest of the broker stays shape-agnostic.
//
// WHY A LEAF: plugin-refresh.mjs (the pure plugin-pull engine the standalone
// catalyst-updater reuses) needs ONLY this helper from the broker. Importing it
// from the heavy router.mjs used to drag the entire broker router (+ bun:sqlite,
// pino, side-effectful init) into plugin-refresh's graph — fine inside the broker
// daemon, but wrong for a lightweight standalone updater agent and unresolvable
// for an execution-core CI test (pino does not resolve cross-tree). Living here,
// plugin-refresh.mjs is a true leaf. router.mjs re-exports getEventName for
// back-compat.
export function getEventName(event) {
  return event.event ?? event.attributes?.["event.name"] ?? "";
}
