#!/usr/bin/env node
// linear-reply.mjs — CTL-1958. Post a MACHINE reply on a Linear issue via the cloud write
// proxy, credential-free:
//   • threaded UNDER the human's comment (parentId = the ROOT of that thread; Linear threads
//     are one level deep, so a reply-to-a-reply must target the root — measured, CTL-1891),
//   • authored as the app actor ("Catalyst Cloud"), never as a personal token (a
//     personal-identity comment reads as the human deciding and clears `needs-human`),
//   • the agent tag rendered in the BODY (see the identity note below).
//
// Usage:
//   node linear-reply.mjs <ISSUE-ID> --as <AGENT> --body <markdown> [--parent <commentId>|--top] [--keep-eyes]
//   (body may also come from stdin: --body -)
// Without --parent/--top: threads under the ROOT of the most recent comment authored by a
// HUMAN (non-bot) user on the issue; if none exists, posts top-level.
// Prints JSON {ok, via, parentId, eyesCleared} on success; non-zero exit + message on failure.
//
// ⛔ CTL-1958 — PROXY-OR-REFUSE, NO CREDENTIAL LEFT. This tool used to mint an app-actor
// token to (a) READ the issue's comments (to find the latest human comment + its reactions)
// and (b) WRITE the comment directly against the Linear GraphQL API. That mint is the
// per-host "Catalyst Orchestrator" credential CTL-1889 exists to retire, so it is GONE:
//   • the READ moves to the local Catalyst-Cloud replica (credential-free) via
//     readReplyContext / readCommentThreadRoot / readIssueId; a missing/unreadable replica
//     throws LOUDLY, never a silent "no comment",
//   • the comment WRITE goes through the CTC-724 cloud `comment` route; any non-`proxy`
//     resolution REFUSES and posts nothing (AC3),
//   • the direct comment-create and direct reaction-delete fallbacks are DELETED.
//
// ⛔ PER-AGENT IDENTITY IS DROPPED UNTIL CTC-762. The cloud `comment` route accepts only
// {issueId, body, parentId?} — it has no parameter for the per-agent author name or avatar
// the old direct mutation passed, so the comment posts as the generic cloud app actor. That
// is a real reader-UX regression, mitigated by rendering the `--as <AGENT>` tag in the body
// (below). The AC requires *app-actor* authorship (preserved), not per-agent identity.
//
// ⛔ THE EYES-CLEAR IS BEST-EFFORT, INCLUDING UNDER ENFORCE. It runs AFTER the comment has
// already been posted; refusing there would report FAILURE for a reply that succeeded, and
// ask.mjs could retry into a DOUBLE-POSTED comment. So a failed clear warns and leaves the
// exit code 0. (linear-ack is deliberately different: there the reaction IS the whole
// operation, so refusing is correct — nothing has been written to contradict.)
import { readFileSync } from "node:fs";
import { readReplyContext, readIssueId, readCommentThreadRoot, isReplicaCurrent } from "./execution-core/replica-comment-read.mjs";
import { getReplicaDbPath } from "./execution-core/config.mjs";

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
}
const issueKey = process.argv[2];
const asAgent = arg("--as", "COORD");
let body = arg("--body", "");
const parentArg = arg("--parent", null);
const top = process.argv.includes("--top");
const keepEyes = process.argv.includes("--keep-eyes");
if (!issueKey || !body) {
  console.error("usage: linear-reply.mjs <ISSUE-ID> --as <AGENT> --body <markdown|-> [--parent <id>|--top] [--keep-eyes]");
  process.exit(2);
}
if (body === "-") body = readFileSync(0, "utf8");
// Identity-loss mitigation (see header): the cloud posts as a generic app actor, so keep the
// agent tag visible in the body itself.
const postBody = `${body}\n\n— _${asAgent}_`;

// Resolve the issue's internal id (needed for the proxy `comment` payload) + the thread
// parent + the 👀 clear target, all credential-free from the replica. A missing/unreadable
// replica throws ReplicaUnavailableError (loud) rather than degrading to a silent no-op.
const DB = getReplicaDbPath();
// CTL-1958: SURFACE a stale replica rather than silently trusting it (the freshness gate the leaf
// exports for exactly this). A present-but-stale replica could miss a very-recently-posted human
// comment → we'd thread top-level or under the wrong root. WARN, don't hard-fail — bounded by the
// ≤5-min freshness threshold, and the read is still the best answer (eyes-clear is best-effort).
if (!isReplicaCurrent(DB)) {
  console.error("linear-reply: WARN — replica may be STALE (cloud-sync writer not fresh); threading/eyes-clear target could be missed.");
}
let issueId = null;
let parentId = null;
let eyesTarget = null; // comment id whose 👀 we clear (best-effort), or null
if (top) {
  issueId = await readIssueId({ dbPath: DB, identifier: issueKey });
  // eyesTarget stays null on purpose. The clear target is "the comment we replied under"
  // (plan §Phase 3: the latest-human-comment id from the read, or the --parent root). A
  // top-level post replies to no one, so there is nothing to clear — deliberately narrower
  // than the old tool, which always cleared the latest human comment's 👀 even on --top
  // (clearing an unrelated human's read-receipt for a comment it did not answer).
} else if (parentArg) {
  issueId = await readIssueId({ dbPath: DB, identifier: issueKey });
  parentId = await readCommentThreadRoot({ dbPath: DB, commentId: parentArg }); // always the root
  eyesTarget = parentId;
} else {
  // `|| undefined`: JS default parameters fire on undefined only, not '', so an explicitly-empty
  // ASK_HUMAN_ID='' would otherwise query author_id='' (matches nothing) → a silent "no comment".
  const ctx = await readReplyContext({ dbPath: DB, identifier: issueKey, humanId: process.env.ASK_HUMAN_ID || undefined });
  issueId = ctx.issueId;
  if (ctx.latest) {
    parentId = ctx.latest.parentId;
    eyesTarget = ctx.latest.id;
  }
}
if (!issueId) {
  console.error(`linear-reply: issue not found in replica: ${issueKey}`);
  process.exit(1);
}

// ── CTL-1961: construct the write proxy once ────────────────────────────────────────
// Constructed, NOT fetched via getLinearWriteProxy() (that accessor returns an installed
// singleton nothing installs in a standalone script). `unavailable` is a REASON, never
// collapsed into "off". ⛔ CTL-2026: the leaf imports MUST live inside the guard (an
// out-of-tree copy cannot resolve them), and the env mode MUST be read BEFORE the guard (an
// unreachable-modules host must still know it is under enforce and refuse, not fall through
// with the "off" initialiser). Env only (no Layer-2) here, so an absent variable is
// UNCONFIRMED, not "off".
const envMode = ["off", "shadow", "enforce"].includes(process.env.CATALYST_LINEAR_WRITE_PROXY)
  ? process.env.CATALYST_LINEAR_WRITE_PROXY
  : null;
let proxyMode = "off";
let proxy = null;
let proxyUnavailable = null;
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
  proxyUnavailable = `proxy modules unreachable: ${err?.message ?? err}`;
  proxyMode = envMode ?? "off";
}

const plan = decideWritePath
  ? decideWritePath({ mode: proxyMode, proxyReady: proxy != null, unavailableReason: proxyUnavailable })
  : proxyMode === "enforce"
    ? { action: "refuse", observe: false, reason: proxyUnavailable ?? "proxy unavailable under enforce" }
    : {
        action: "direct",
        observe: false,
        reason: `${proxyUnavailable ?? "write-path leaf unreachable"}${envMode ? "" : "; CATALYST_LINEAR_WRITE_PROXY unset, so the mode is UNCONFIRMED (Layer-2 unreadable without the modules)"}`,
      };

// proxy-or-refuse for the COMMENT WRITE. Unlike the eyes-clear below, refusing here fails the
// WHOLE operation (nothing posted) — this is the credential-free AC3 gate.
if (plan.action !== "proxy") {
  const why =
    plan.action === "refuse"
      ? plan.reason
      : `resolution=${plan.action} but there is no direct app-actor write path anymore (mint removed)`;
  console.error(
    `linear-reply: REFUSED — mode=${proxyMode}, no comment posted (${why}). These tools require CATALYST_LINEAR_WRITE_PROXY=enforce + a cloud token.`
  );
  process.exit(1);
}

const res = proxy.send({
  routeId: "comment",
  ticket: issueKey,
  payload: { issueId, body: postBody, ...(parentId ? { parentId } : {}) },
  caller: "linear-reply",
});
if (!res?.handled || res.applied !== true) {
  console.error(`linear-reply: REFUSED — the proxy did not apply the comment (${res?.reason ?? "unknown"}). Nothing posted.`);
  process.exit(1);
}

// 👀 clear on the comment we replied under — BEST-EFFORT. The replica has no reactions table,
// but the proxy `reaction`/remove is idempotent and deletes every matching reaction
// server-side (reporting the count), so no pre-read is needed. A failure only warns; it never
// changes the exit code (the reply is already posted).
let cleared = 0;
if (!keepEyes && eyesTarget) {
  try {
    const rx = proxy.send({
      routeId: "reaction",
      ticket: issueKey,
      payload: { commentId: eyesTarget, emoji: "eyes", mode: "remove" },
      caller: "linear-reply",
    });
    if (rx?.handled && rx.applied === true) cleared = 1;
    else console.error(`linear-reply: 👀 NOT cleared (${rx?.reason ?? "unknown"}). The reply itself was posted.`);
  } catch (err) {
    console.error(`linear-reply: 👀 NOT cleared — proxy threw (${err?.message}). The reply itself was posted.`);
  }
}

console.log(JSON.stringify({ ok: true, via: "proxy", parentId, eyesCleared: cleared }));
