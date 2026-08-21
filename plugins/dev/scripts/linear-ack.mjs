#!/usr/bin/env node
// linear-ack.mjs <ISSUE> [--emoji eyes] [--remove] [--comment-id <id>] — CTL-1958
// Record the 👀 "read, working on it" claim (as the app actor) on the latest HUMAN comment
// of an issue, THROUGH the cloud write proxy.
//
// ⛔ CTL-1958 — PROXY-OR-REFUSE, NO CREDENTIAL LEFT. This tool used to mint an app-actor
// token and both READ (find the latest human comment) and WRITE (the direct reaction
// mutations) against the Linear GraphQL API. That mint is the per-host "Catalyst
// Orchestrator" credential CTL-1889 exists to retire, so it is GONE:
//   • the READ moves to the local Catalyst-Cloud replica (credential-free, ~/catalyst/
//     catalyst-replica.db) via readLatestHumanComment; a missing/unreadable replica throws
//     LOUDLY (never a silent "no comment"),
//   • the reaction WRITE was already routed through the CTC-724 `reaction` route (CTL-1961),
//   • the direct add/remove reaction mutations are DELETED — there is no app-actor write
//     path on this host anymore, so anything the write-path leaf does not resolve to
//     `proxy` REFUSES and writes nothing (AC3). The reaction IS the whole operation here
//     (unlike linear-reply's best-effort eyes-clear), so refusing is the correct terminal
//     answer and nothing has been written to contradict.
//
// These tools therefore require CATALYST_LINEAR_WRITE_PROXY=enforce + a cloud token; every
// other resolution (off/shadow/unset, or enforce with no reachable proxy) refuses.
//
// Prints JSON {via:"proxy", applied, commentId, emoji, mode} on success.
import { readLatestHumanComment, isReplicaCurrent } from "./execution-core/replica-comment-read.mjs";
import { getReplicaDbPath } from "./execution-core/config.mjs";

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
}
const key = process.argv[2];
const emoji = arg("--emoji", "eyes");
const remove = process.argv.includes("--remove");
const commentIdArg = arg("--comment-id", null);
if (!key) {
  console.error("usage: linear-ack.mjs <ISSUE-ID> [--emoji eyes] [--remove] [--comment-id <id>]");
  process.exit(2);
}

// Resolve the target comment id. --comment-id is the fast path (skips the read entirely);
// otherwise read the latest human comment from the replica. readLatestHumanComment THROWS
// (ReplicaUnavailableError) when the replica is absent/unreadable, so a missing replica is
// loud, not a silent no-op. `null` = the DB is fine but the issue has no human comment.
let commentId = commentIdArg;
if (!commentId) {
  const dbPath = getReplicaDbPath();
  // CTL-1958: SURFACE a stale replica rather than silently trusting it (the freshness gate the
  // leaf exports for exactly this). A present-but-stale replica (fresh-looking file, dead
  // cloud-sync writer) could miss a very-recently-posted human comment. WARN, don't hard-fail —
  // bounded by the ≤5-min freshness threshold, and the read below is still the best answer.
  if (!isReplicaCurrent(dbPath)) {
    console.error("linear-ack: WARN — replica may be STALE (cloud-sync writer not fresh); the latest human comment could be missed.");
  }
  const latest = await readLatestHumanComment({
    dbPath,
    identifier: key,
    humanId: process.env.ASK_HUMAN_ID || undefined, // '' or unset → the leaf's DEFAULT_ASK_HUMAN_ID (JS defaults fire on undefined only, not '')
  });
  if (!latest) {
    console.log("no human comment");
    process.exit(0);
  }
  commentId = latest.id;
}

// ── CTL-1961: construct the write proxy once ────────────────────────────────────────
// Constructed, NOT fetched via getLinearWriteProxy(): that accessor returns an installed
// singleton nothing installs in a standalone script, so it answers null every time and the
// routing would silently never engage. `unavailable` is kept as a REASON rather than
// collapsed into "off" — see lib/linear-write-path.mjs on why those must never be one answer.
//
// ⛔ CTL-2026 — THE LEAF IMPORT MUST BE INSIDE THIS GUARD. The catch below exists BECAUSE an
// out-of-tree copy cannot resolve these imports; importing the leaf on its own line above the
// try would die with an unhandled module-resolution error before the branch written for that
// case could run. (Measured 2026-08-18 by copying this file alone into an empty directory.)
//
// ⛔ AND THE MODE MUST BE READ BEFORE THE GUARD. `proxyMode` was assigned INSIDE the try, so an
// unreachable-modules host fell through with the initialiser "off" still in place — the one
// state in which the refusal matters was also the one state that computed "no proxy configured".
// The env read below is the only mode source that survives the modules being gone; it is
// deliberately weaker (env only, no Layer-2), so an absent variable reports UNCONFIRMED, not "off".
const envMode = ["off", "shadow", "enforce"].includes(process.env.CATALYST_LINEAR_WRITE_PROXY)
  ? process.env.CATALYST_LINEAR_WRITE_PROXY
  : null;
let proxyMode = "off";
let proxy = null;
let proxyUnavailable = null; // a REASON, never a silent null — see below
let decideWritePath = null;
try {
  const [{ createLinearWriteProxy }, { readLinearWriteProxyConfig }, writePath] = await Promise.all([
    import("./execution-core/linear-write-proxy.mjs"),
    import("./execution-core/config.mjs"),
    import("./lib/linear-write-path.mjs"),
  ]);
  decideWritePath = writePath.decideWritePath;
  const cfg = readLinearWriteProxyConfig(process.env);
  proxyMode = cfg.mode ?? "off";
  if (proxyMode === "shadow" || proxyMode === "enforce") {
    proxy = createLinearWriteProxy({ mode: proxyMode, env: process.env, routes: cfg.routes });
    if (!proxy) proxyUnavailable = `createLinearWriteProxy returned null for mode=${proxyMode}`;
  }
} catch (err) {
  // ⛔ NOT the same as `off`. An out-of-tree copy of this tool cannot resolve these imports at
  // all (CTL-2026), and a typo'd export name looks identical from here — so the reason is kept
  // and, under enforce, it REFUSES rather than quietly writing (there is no direct path anymore).
  proxyUnavailable = `proxy modules unreachable: ${err?.message ?? err}`;
  proxyMode = envMode ?? "off";
}

const mode = remove ? "remove" : "add";
// ⛔ We cannot ask the leaf what to do about the leaf being missing. This restates its
// STRICTEST branch: with no transport, `enforce` REFUSES; every other mode ALSO refuses now
// (the direct app-actor write is gone), so the dispatch below collapses anything != "proxy"
// to refuse regardless. Pinned against the real function by the unreachable-leaf fallback test.
const plan = decideWritePath
  ? decideWritePath({ mode: proxyMode, proxyReady: proxy != null, unavailableReason: proxyUnavailable })
  : proxyMode === "enforce"
    ? { action: "refuse", observe: false, reason: proxyUnavailable ?? "proxy unavailable under enforce" }
    : {
        action: "direct",
        observe: false,
        reason: `${proxyUnavailable ?? "write-path leaf unreachable"}${envMode ? "" : "; CATALYST_LINEAR_WRITE_PROXY unset, so the mode is UNCONFIRMED (Layer-2 unreadable without the modules)"}`,
      };

// proxy-or-refuse: only `proxy` writes. off/shadow/enforce-without-proxy all REFUSE, because
// no app-actor write path remains on this host (AC3). Preserves the `REFUSED — mode=…` shape.
if (plan.action !== "proxy") {
  const why =
    plan.action === "refuse"
      ? plan.reason
      : `resolution=${plan.action} but there is no direct app-actor write path anymore (mint removed)`;
  console.error(
    `linear-ack: REFUSED — mode=${proxyMode}, nothing written (${why}). These tools require CATALYST_LINEAR_WRITE_PROXY=enforce + a cloud token.`
  );
  process.exit(1);
}

const res = proxy.send({ routeId: "reaction", ticket: key, payload: { commentId, emoji, mode }, caller: "linear-ack" });
// ⛔ GUARD BOTH `handled` AND `applied` (mirrors linear-reply.mjs:155). Under enforce the
// proxy returns {handled:true, applied:false, reason} for EVERY genuine write failure —
// unauthorized 401/403, rate-limited 429, server-error 5xx, no-cloud-token, and the host-budget
// refuse gate (linear-write-proxy.mjs). A `!res?.handled`-only guard let those pass and printed
// applied:false with exit 0 — a silent failure. The reaction IS the whole operation here (the
// 👀 "read, working on it" claim), and callers (ask/concierge/steward) key off the exit status,
// so a non-applied reaction MUST fail LOUDLY with no fallback (ticket AC).
if (!res?.handled || res.applied !== true) {
  console.error(`linear-ack: REFUSED — the proxy did not apply the reaction (${res?.reason ?? "unknown"}). Nothing written.`);
  process.exit(1);
}
console.log(JSON.stringify({ via: "proxy", applied: true, commentId, emoji, mode }));
