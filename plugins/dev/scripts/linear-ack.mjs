// linear-react.mjs <ISSUE> [--emoji eyes] [--remove] — react (as the app actor) to the latest HUMAN comment on an issue
const GQL="https://api.linear.app/graphql", OAUTH="https://api.linear.app/oauth/token";
const key=process.argv[2]; const emoji=(process.argv.indexOf("--emoji")>=0?process.argv[process.argv.indexOf("--emoji")+1]:"eyes"); const remove=process.argv.includes("--remove");
const r=await fetch(OAUTH,{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"client_credentials",client_id:process.env.LINEAR_SYNC_CLIENT_ID,client_secret:process.env.LINEAR_SYNC_CLIENT_SECRET,scope:"read,write,comments:create,app:assignable,app:mentionable",actor:"app"})}); const tok=(await r.json()).access_token;
const g=async(q,v)=>{const x=await fetch(GQL,{method:"POST",headers:{"content-type":"application/json",authorization:tok},body:JSON.stringify({query:q,variables:v})});const j=await x.json(); if(j.errors) throw new Error(JSON.stringify(j.errors).slice(0,300)); return j.data;};
const d=await g(`query($k:String!){ issue(id:$k){ comments(first:100, orderBy: createdAt){ nodes{ id createdAt user{ id name } botActor{ type } reactions{ id emoji user{ id } } } } } }`,{k:key});
const humans=d.issue.comments.nodes.filter(n=>n.user&&!n.botActor&&n.user.id===(process.env.ASK_HUMAN_ID||"c2a8cc92-cab6-4536-9500-0f24abdf702b")).sort((a,b)=>a.createdAt.localeCompare(b.createdAt)); const last=humans[humans.length-1]; if(!last){console.log("no human comment");process.exit(0);}
// ── CTL-1961: the WRITE goes through the cloud proxy; the READ above stays direct ───
// The skinny-install contract is that a host may keep a Linear credential for READS but
// must not hold a direct WRITE path. The comment lookup above is a read and is unchanged;
// only reactionCreate/reactionDelete are routed.
//
// Modes follow linear-comment-write.mjs, because a second dialect of "what does shadow
// mean" is how the two drift:
//   off      → direct, byte-identical to before this change
//   shadow   → record the observation, then perform the direct write (a reaction is a
//              WRITE, so "observe by doing it too" would double-write)
//   enforce  → proxy only. A failure REFUSES and exits non-zero; it is never retried
//              direct, because falling back would defeat the gate on exactly the runs
//              where it matters.
//
// ⛔ The proxy is CONSTRUCTED here, not fetched with `getLinearWriteProxy()`. That
// accessor returns a module-level singleton that something else must have INSTALLED, and
// nothing installs it in a standalone script — so it answers `null` every time and the
// routing would silently never engage. A gate that cannot fire is worse than no gate,
// because it reports the same thing as a working one. Construction mirrors
// `cluster-claim.mjs`'s defaultTransport, which had to solve this same problem.
//
// ⛔ CTL-2026 — THE LEAF IMPORT MUST BE INSIDE THIS GUARD, AND IT WAS NOT.
// The catch below exists BECAUSE an out-of-tree copy cannot resolve these imports. The
// first cut then imported `./lib/linear-write-path.mjs` on its own line, OUTSIDE the try —
// so a copy of this file with no sibling directories died with an unhandled module
// resolution error before it could take the very branch written to handle that case.
// Measured 2026-08-18 by copying this file alone into an empty directory and running it:
// `Cannot find module '<dir>/lib/linear-write-path.mjs'`, no reaction attempted, no reason
// printed. `~/catalyst/comms/tools/` is exactly that shape, and CTL-2026(b)'s announced
// sync step is what would have put this file there. A guard whose result is consumed
// outside the guard is not a guard.
//
// ⛔ AND THE MODE MUST BE READ BEFORE THE GUARD, NOT INSIDE IT.
// `proxyMode` was assigned from `readLinearWriteProxyConfig` INSIDE the try, so an
// unreachable-modules host fell through with the initialiser `"off"` still in place —
// i.e. the one state in which the refusal matters was also the one state that computed
// "no proxy configured". The env read below is the only mode source that survives the
// modules being gone. It is deliberately WEAKER than the real ladder (env only, no
// Layer-2), so it reports `null` = "could not confirm" rather than claiming `"off"`.
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
  // ⛔ NOT the same as `off`. An out-of-tree copy of this tool cannot resolve these
  // imports at all (CTL-2026), and a typo'd export name looks identical from here — the
  // first cut of this change imported a name that does not exist and would have degraded
  // to "direct" forever while looking like a routed tool. So the reason is kept and, under
  // enforce, it REFUSES rather than quietly writing direct.
  proxyUnavailable = `proxy modules unreachable: ${err?.message ?? err}`;
  proxyMode = envMode ?? "off";
}

const viaProxy = async (mode) => {
  const res = proxy.send({
    routeId: "reaction",
    ticket: key,
    payload: { commentId: last.id, emoji, mode },
    caller: "linear-ack",
  });
  if (!res?.handled) throw new Error(`proxy did not handle the write: ${res?.reason ?? "unknown"}`);
  return res;
};

const directRemove = async () => {
  // The route's remove mode deletes EVERY matching reaction and reports the count, which
  // is what this loop already did — so the two paths agree rather than merely coexisting.
  const mine = last.reactions.filter((x) => x.emoji === emoji);
  for (const x of mine) await g(`mutation($id:String!){ reactionDelete(id:$id){ success } }`, { id: x.id });
  return { removed: mine.length, commentId: last.id };
};
const directAdd = async () => {
  const m = await g(`mutation($in:ReactionCreateInput!){ reactionCreate(input:$in){ success reaction{ id } } }`, {
    in: { commentId: last.id, emoji },
  });
  return { ok: m.reactionCreate.success, commentId: last.id, emoji };
};

const mode = remove ? "remove" : "add";
// ⛔ We cannot ask the leaf what to do about the leaf being missing. This restates its
// STRICTEST branch and nothing else — with no transport, `enforce` REFUSES and every other
// mode writes direct — and it is pinned against the real function by "the unreachable-leaf
// fallback" in lib/linear-write-path.test.mjs, which fails if that branch ever changes.
// An env that never named a mode is reported as UNCONFIRMED rather than as `off`: this
// degraded path cannot read Layer-2, so "no mode here" is not evidence of "no mode".
const plan = decideWritePath
  ? decideWritePath({ mode: proxyMode, proxyReady: proxy != null, unavailableReason: proxyUnavailable })
  : proxyMode === "enforce"
    ? { action: "refuse", observe: false, reason: proxyUnavailable ?? "proxy unavailable under enforce" }
    : {
        action: "direct",
        observe: false,
        reason: `${proxyUnavailable ?? "write-path leaf unreachable"}${envMode ? "" : "; CATALYST_LINEAR_WRITE_PROXY unset, so the mode is UNCONFIRMED (Layer-2 unreadable without the modules)"}`,
      };

if (plan.action === "refuse") {
  console.error(`linear-ack: REFUSED — mode=${proxyMode} but the proxy is unavailable (${plan.reason})`);
  process.exit(1);
}
if (plan.action === "proxy") {
  const res = await viaProxy(mode);
  console.log(JSON.stringify({ via: "proxy", applied: res.applied === true, commentId: last.id, emoji, mode }));
} else {
  if (plan.observe) {
    try {
      await viaProxy(mode);
    } catch (err) {
      console.error(`linear-ack: proxy threw in shadow (the direct write still happens): ${err?.message}`);
    }
  } else if (plan.reason) {
    console.error(`linear-ack: ${plan.reason} — writing direct`);
  }
  console.log(JSON.stringify({ via: "direct", ...(remove ? await directRemove() : await directAdd()) }));
}
