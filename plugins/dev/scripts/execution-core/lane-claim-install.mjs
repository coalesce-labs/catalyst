// lane-claim-install.mjs — CTL-2068. The process-wide install slot for the lane-claim
// guard. Nothing else; this module exists to be a LEAF, exactly like
// linear-write-proxy-install.mjs and for the same reason: the guard is consulted from
// linear-write.mjs, and its production construction needs the replica reader and the
// bot-id set that daemon.mjs owns. A single storage location keeps the daemon and every
// write path looking at the same guard — two `let`s would let one path read an installed
// guard while another silently used none.
//
// Zero imports on purpose.

let _laneClaimGuard = null;

/** setLaneClaimGuard — install (or clear, with null) the CTL-2068 guard. */
export function setLaneClaimGuard(guard) {
  _laneClaimGuard = guard ?? null;
}

/** getLaneClaimGuard — read the installed guard (null when never installed). */
export function getLaneClaimGuard() {
  return _laneClaimGuard;
}
