// worker-label-names.mjs — CTL-1481: the canonical worker-ownership label
// name constants, isolated in a ZERO-IMPORT leaf. doctor.mjs runs under bare
// Node and must import these without pulling worker-label.mjs's module graph
// (linear-query.mjs → gateway-read.mjs statically imports bun:sqlite, which
// the Node ESM loader rejects at load time). Everything else should import
// from worker-label.mjs, which re-exports both.

// The workspace-level label group's own name (matched by name + parent==null,
// per the #2631 isGroup gotcha). Provisioned by setup-execution-core-states.sh
// (which necessarily duplicates the string — bash), asserted by doctor.mjs.
export const WORKER_LABEL_GROUP = "worker";

// The shared prefix for the per-host children of the workspace group. A
// ticket's desired label is always `${WORKER_LABEL_PREFIX}${hostName}`.
export const WORKER_LABEL_PREFIX = "worker:";
