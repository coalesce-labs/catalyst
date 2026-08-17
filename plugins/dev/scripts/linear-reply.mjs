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
const d = await gql(token, `query($k:String!){ issue(id:$k){ id url comments(first:100, orderBy: createdAt){ nodes{ id createdAt parent{ id } user{ id name } botActor{ type userDisplayName } } } } }`, { k: issueKey });
const issue = d.issue;
if (!issue) { console.error("issue not found: " + issueKey); process.exit(1); }

let parentId = null;
if (parentArg) {
  const c = issue.comments.nodes.find(n => n.id === parentArg);
  parentId = c?.parent?.id ?? parentArg; // always the root
} else if (!top) {
  const humans = issue.comments.nodes.filter(n => n.user && !n.botActor);
  const last = humans[humans.length - 1];
  if (last) parentId = last.parent?.id ?? last.id;
}
const m = await gql(token, `mutation($in:CommentCreateInput!){ commentCreate(input:$in){ success comment{ id url } } }`, {
  in: { issueId: issue.id, body, createAsUser: asAgent, ...(parentId ? { parentId } : {}) },
});
console.log(JSON.stringify({ ok: m.commentCreate.success, commentId: m.commentCreate.comment.id, parentId, url: m.commentCreate.comment.url }));
