#!/usr/bin/env node
// node-roster.mjs — cluster ENROLLMENT channel (CTL-1273).
//
// STUB — minimal anchor for the CTL-1273/CTL-1271 keystone build. The full
// node-registration read/write machinery (persistent `catalyst://node/<name>`
// attachments on the Linear cluster anchor, mirroring cluster-heartbeat.mjs)
// lands in the next commit on this branch.

export const NODE_URL_PREFIX = "catalyst://node/";

// nodeUrl — the per-node enrollment attachment url; the unique key Linear
// upserts on.
export function nodeUrl(name) {
  return `${NODE_URL_PREFIX}${name}`;
}
