#!/usr/bin/env node
// linear-reply.mjs — post a MACHINE reply on a Linear issue the way Ryan asked (2026-08-17):
//   • threaded UNDER the human's comment (parentId = the ROOT of that thread; Linear threads are
//     one level deep, so a reply-to-a-reply must target the root — measured, CTL-1891),
//   • authored as the APP ACTOR ("Catalyst Cloud"), never as the personal token (a personal-identity
//     comment reads as the human deciding and clears `needs-human` — CTL-1567 gate),
//   • tagged with the agent's name via createAsUser (shows as botActor.userDisplayName).
//
// Usage:
//   node linear-reply.mjs <ISSUE-ID> --as <AGENT> --body <markdown> [--parent <commentId>|--top]
//   (body may also come from stdin: --body -)
// Env: LINEAR_SYNC_CLIENT_ID / LINEAR_SYNC_CLIENT_SECRET (direnv catalyst-cloud profile).
// Without --parent/--top: threads under the ROOT of the most recent comment authored by a HUMAN
// (non-bot) user on the issue; if none exists, posts top-level.
// Prints JSON {ok, commentId, parentId, url} on success; non-zero exit + message on failure.

import { readFileSync } from "node:fs";

const GQL = "https://api.linear.app/graphql";
const OAUTH = "https://api.linear.app/oauth/token";
const SCOPE = "read,write,comments:create,app:assignable,app:mentionable";

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
}
const issueKey = process.argv[2];
const asAgent = arg("--as", "COORD");
let body = arg("--body", "");
const parentArg = arg("--parent", null);
const top = process.argv.includes("--top");
if (!issueKey || !body) {
  console.error("usage: linear-reply.mjs <ISSUE-ID> --as <AGENT> --body <markdown|-> [--parent <id>|--top]");
  process.exit(2);
}
if (body === "-") body = readFileSync(0, "utf8");

const cid = process.env.LINEAR_SYNC_CLIENT_ID, csec = process.env.LINEAR_SYNC_CLIENT_SECRET;
if (!cid || !csec) { console.error("LINEAR_SYNC_CLIENT_ID/SECRET missing (run under direnv)"); process.exit(2); }

async function mint() {
  const r = await fetch(OAUTH, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: cid, client_secret: csec, scope: SCOPE, actor: "app" }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error("mint failed: " + JSON.stringify(j).slice(0, 200));
  return j.access_token;
}
async function gql(token, query, variables) {
  const r = await fetch(GQL, { method: "POST", headers: { "content-type": "application/json", authorization: token }, body: JSON.stringify({ query, variables }) });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 400));
  return j.data;
}

const token = await mint();
const d = await gql(token, `query($k:String!){ issue(id:$k){ id url comments(first:100, orderBy: createdAt){ nodes{ id createdAt parent{ id } user{ id name } botActor{ type userDisplayName } reactions{ id emoji } } } } }`, { k: issueKey });
const issue = d.issue;
if (!issue) { console.error("issue not found: " + issueKey); process.exit(1); }

let parentId = null;
if (parentArg) {
  const c = issue.comments.nodes.find(n => n.id === parentArg);
  parentId = c?.parent?.id ?? parentArg; // always the root
} else if (!top) {
  const humans = issue.comments.nodes.filter(n => n.user && !n.botActor && n.user.id === (process.env.ASK_HUMAN_ID || "c2a8cc92-cab6-4536-9500-0f24abdf702b")).sort((a,b)=>a.createdAt.localeCompare(b.createdAt)); // API order is newest-first; sort ASC explicitly
  const last = humans[humans.length - 1];
  if (last) parentId = last.parent?.id ?? last.id;
}
// ── CTL-1961: construct the write proxy once, for the eyes-clear below ──────────────
// Constructed, NOT fetched via getLinearWriteProxy(): that accessor returns an installed
// singleton nothing installs in a standalone script, so it answers null every time and the
// routing would silently never engage. `unavailable` is kept as a REASON rather than
// collapsed into "off" — see lib/linear-write-path.mjs on why those must never be one answer.
//
// ⛔ CTL-2026 — THE LEAF IMPORT BELONGS INSIDE THE GUARD. It used to sit on its own line
// above the try, so a copy of this file with no sibling directories died with an unhandled
// module resolution error — before the reply was posted, and before the catch written for
// exactly that case could run. Measured 2026-08-18 by copying this file alone into an empty
// directory: `Cannot find module '<dir>/lib/linear-write-path.mjs'`. `~/catalyst/comms/tools/`
// is that shape, and CTL-2026(b)'s announced sync step is what puts this file there. See
// linear-ack.mjs for the same fix and the same reasoning.
//
// The env-only mode read is likewise BEFORE the guard: `proxyMode` was assigned inside the
// try, so an unreachable-modules host kept the initialiser `"off"` — the one state where
// the mode matters was the one state that reported none. Env only (no Layer-2), so an
// absent variable is reported as UNCONFIRMED rather than as `off`.
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

// Ryan (2026-08-18 19:4x): a consistent per-agent avatar next to the createAsUser name. Deterministic from the
// agent tag so the same agent always renders the same image; Linear's CommentCreateInput has `displayIconUrl`
// (measured against the live schema). Override the generator with CATALYST_AVATAR_URL_TEMPLATE (use {slug}).
//
// ⛔ CARRIED FORWARD VERBATIM from ~/catalyst/comms/tools/linear-reply.mjs, NOT rewritten (CTL-2026).
// Ryan hand-edited the OUT-OF-TREE copy at 19:46:30 on 2026-08-18; the repo copy was last touched
// 2026-08-17 (#3484). So CTL-2026's founding measurement — "they are true copies, byte-identical" —
// was already false six hours after it was written, and option (a) (make the out-of-tree file a thin
// wrapper that execs THIS file) would have silently DELETED these avatars on every lane's next reply.
// That is the whole reason the repo copy has to be brought level before (a) lands. Any "improvement"
// here re-opens the same gap in the other direction, so this is a transcription, not a redesign.
const avatarSlug = encodeURIComponent(String(asAgent).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""));
const avatarTemplate = process.env.CATALYST_AVATAR_URL_TEMPLATE || "https://api.dicebear.com/9.x/shapes/svg?seed={slug}";
const displayIconUrl = avatarTemplate.replace("{slug}", avatarSlug);
const m = await gql(token, `mutation($in:CommentCreateInput!){ commentCreate(input:$in){ success comment{ id url } } }`, {
  in: { issueId: issue.id, body, createAsUser: asAgent, displayIconUrl, ...(parentId ? { parentId } : {}) },
});
// Ryan (2026-08-17): 👀 on the human's LATEST comment means "read, working on it"; it comes OFF once the reply
// is posted (not at resolution). Clear any eyes reactions on the comment we replied under, unless --keep-eyes.
//
// ⛔ CTL-1961 — WHY ONLY THIS WRITE IS ROUTED AND THE COMMENT ABOVE IS NOT.
// The eyes-clear goes through the CTC-724 `reaction` route. The commentCreate above stays
// DIRECT, and that is a declared exception with a named blocker, not an oversight: this
// tool passes `createAsUser: asAgent` — the `--as <AGENT>` flag that makes a reply show as
// "CTL-INSTALL"/"FLEET" rather than an undifferentiated app actor — and the cloud route
// `POST /api/v1/agent/issue-comment` accepts only {issueId, body, parentId?, hostId}. It
// carries no display name (measured: 0 occurrences of createAsUser/displayName/agentName
// in agent-write-routes.ts at ba3a722; positive control — `parentId` returns 7 in the same
// file). Routing it today would post the right comment in the right thread with the AUTHOR
// STRIPPED, on the busiest surface we have, and would look fine while doing it.
// ⚠️ CTL-2026 makes that blocker BIGGER, not smaller: the input now also carries
// `displayIconUrl` (the per-agent avatar above), which is a second author-identity field
// the cloud route has no parameter for. Whoever lands CTC-762 must add BOTH, and the
// route's acceptance test should name both — adding only `createAsUser` would restore the
// name and silently drop the avatar, which is the identical failure one field along.
// Tracked as CTC-762; until it lands, doctor must report this path as a NAMED EXCEPTION
// rather than passing — a gate that quietly excuses the busiest write path is not a gate.
let cleared = 0;
if (!process.argv.includes("--keep-eyes")) {
  const target = issue.comments.nodes.filter(n => n.user && !n.botActor && n.user.id === (process.env.ASK_HUMAN_ID || "c2a8cc92-cab6-4536-9500-0f24abdf702b")).sort((a,b)=>a.createdAt.localeCompare(b.createdAt)).slice(-1)[0];
  const eyes = (target?.reactions ?? []).filter(r => r.emoji === "eyes");
  if (eyes.length > 0) {
    // The route's remove mode deletes EVERY matching reaction on the target and reports the
    // count, which is exactly what the loop below does — so the two paths agree rather than
    // merely coexisting.
    // The unreachable-leaf fallback: see linear-ack.mjs. Same strictest-branch restatement,
    // pinned by the same invariant test. Here `refuse` only SKIPS the clear (below).
    const plan = decideWritePath
      ? decideWritePath({ mode: proxyMode, proxyReady: proxy != null, unavailableReason: proxyUnavailable })
      : proxyMode === "enforce"
        ? { action: "refuse", observe: false, reason: proxyUnavailable ?? "proxy unavailable under enforce" }
        : {
            action: "direct",
            observe: false,
            reason: `${proxyUnavailable ?? "write-path leaf unreachable"}${envMode ? "" : "; CATALYST_LINEAR_WRITE_PROXY unset, so the mode is UNCONFIRMED (Layer-2 unreadable without the modules)"}`,
          };
    // ⛔ THE EYES-CLEAR IS BEST-EFFORT AND MUST STAY THAT WAY, INCLUDING UNDER ENFORCE.
    // It runs AFTER the comment above has already been posted. `refuse` here — exiting
    // non-zero the way linear-ack correctly does — would report FAILURE for a reply that
    // actually succeeded, and the caller (`ask.mjs:469` invokes this script) could retry
    // into a DOUBLE-POSTED comment. Both minis run CATALYST_LINEAR_WRITE_PROXY=enforce, so
    // this is the live path, not a hypothetical one.
    //
    // The house rule this restores is already written down elsewhere in this repo: a
    // cleanup step must never be able to fail the thing it cleans up after. The original
    // code said the same thing with `try { … } catch {}`; routing must not quietly
    // upgrade a swallowed cleanup into a fatal one.
    //
    // linear-ack is deliberately DIFFERENT: there the reaction IS the whole operation, so
    // refusing is the correct answer and nothing has been written yet to contradict.
    if (plan.action === "proxy" || plan.action === "refuse") {
      if (plan.action === "refuse") {
        console.error(`linear-reply: 👀 NOT cleared — mode=${proxyMode} and the proxy is unavailable (${plan.reason}). The reply itself was posted.`);
      } else {
        let res = null;
        try {
          res = proxy.send({
            routeId: "reaction",
            ticket: issueKey,
            payload: { commentId: target.id, emoji: "eyes", mode: "remove" },
            caller: "linear-reply",
          });
        } catch (err) {
          console.error(`linear-reply: 👀 NOT cleared — proxy threw (${err?.message}). The reply itself was posted.`);
        }
        if (res?.handled) cleared = eyes.length;
        else if (res) console.error(`linear-reply: 👀 NOT cleared — proxy did not handle it (${res?.reason ?? "unknown"}). The reply itself was posted.`);
      }
    } else {
      if (plan.observe) {
        try {
          proxy.send({ routeId: "reaction", ticket: issueKey, payload: {}, caller: "linear-reply" });
        } catch (err) {
          console.error(`linear-reply: proxy threw in shadow (the direct clear still happens): ${err?.message}`);
        }
      } else if (plan.reason) {
        console.error(`linear-reply: ${plan.reason} — clearing 👀 direct`);
      }
      for (const rx of eyes) {
        try { await gql(token, `mutation($id:String!){ reactionDelete(id:$id){ success } }`, { id: rx.id }); cleared++; } catch {}
      }
    }
  }
}
console.log(JSON.stringify({ ok: m.commentCreate.success, commentId: m.commentCreate.comment.id, parentId, url: m.commentCreate.comment.url, eyesCleared: cleared }));
