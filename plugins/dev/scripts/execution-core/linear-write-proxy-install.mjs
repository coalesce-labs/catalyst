// linear-write-proxy-install.mjs — CTL-1889 increment 2.
//
// The process-wide install slots for the cloud write transport and its id resolver.
// Nothing else. This module exists to be a LEAF.
//
// ── ⛔ WHY THIS IS ITS OWN FILE, AND WHY THAT IS NOT BUREAUCRACY ──
// These two slots lived in `linear-write.mjs`, which was fine while the only proxied
// routes were the issue-field writes that module owns. Increment 2 routes COMMENTS, and
// comments are posted from six execution-core modules — one of which is
// `linear-query.mjs`, which `linear-write.mjs` already imports FROM.
//
// So putting the comment seam in `linear-write.mjs` would make
// `linear-write → linear-query → linear-write` a cycle. ESM tolerates cycles, which is
// precisely what makes them dangerous here: it would work until someone moved a call to
// module-initialisation time, and then fail as a half-initialised binding rather than as
// an import error. Extracting the slots removes the possibility instead of documenting it.
//
// ⚠️ There must be exactly ONE storage location for each slot. `linear-write.mjs`
// re-exports these functions rather than keeping its own copy — a second `let` would give
// the daemon and the comment path two different proxies, and the one the daemon installed
// would look correctly installed from every existing call site while the comment path
// silently used none.
//
// Zero imports on purpose: every consumer of a Linear write can reach it without dragging
// a dependency graph behind it.

let _writeProxy = null;
let _proxyResolver = null;

/** setLinearWriteProxy — install (or clear, with null) the cloud write transport. */
export function setLinearWriteProxy(proxy) {
  _writeProxy = proxy ?? null;
}

/** getLinearWriteProxy — test/diagnostic read of the installed transport. */
export function getLinearWriteProxy() {
  return _writeProxy;
}

/**
 * setLinearWriteProxyResolver — install the replica-backed identifier/name → UUID
 * resolver the enforce path needs to build a payload.
 */
export function setLinearWriteProxyResolver(resolver) {
  _proxyResolver = resolver ?? null;
}

/** getLinearWriteProxyResolver — test/diagnostic read of the installed resolver. */
export function getLinearWriteProxyResolver() {
  return _proxyResolver;
}
