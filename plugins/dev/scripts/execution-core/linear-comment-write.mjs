// linear-comment-write.mjs — CTL-1889 increment 2.
//
// The ONE seam every host-side Linear COMMENT goes through, so that under `enforce` a
// comment is written by Catalyst Cloud under its single grant instead of by this host's
// own Catalyst Orchestrator app-actor.
//
// ── WHAT INCREMENT 1 LEFT, AND WHY IT LEFT IT ──
// `linear-write.mjs` is the chokepoint for issue-FIELD writes (state, labels, estimate,
// assignee, blocked-by) and increment 1 routed the two the cloud already served. Comments
// were explicitly out of scope because they have their own transport —
// `lib/linear-comment-post.sh`, which MINTS A PER-HOST APP-ACTOR TOKEN PER CALL. That
// mint is exactly the credential CTL-1889 exists to retire, so every comment posted
// through it keeps the shadow window from ever reading "zero host-originated writes".
//
// ── ⛔ THE MEASURED CALL SITES: FIVE, AND linear-query.mjs IS NOT ONE ──
// Measured 2026-08-18 on origin/main. Five execution-core modules invoke the helper —
// `recovery-emit.mjs`, `recovery-reasoning.mjs`, `recovery.mjs`,
// `unstuck-escalate-seam.mjs`, `unstuck-sweep.mjs`. A plain grep for the helper's name
// also hits `linear-query.mjs`, but that is PROSE: a comment explaining that its auth
// header matches the helper's. Counting it produced a false structural finding (an import
// cycle that does not exist, since `linear-write.mjs` imports `linear-query.mjs`), which
// is recorded here because the grep will hit it again for the next person.
//
// ── WHY THIS IS A SEPARATE MODULE FROM linear-write.mjs ──
// Not a cycle (see above) — WEIGHT. `linear-write.mjs` pulls in the registry, the query
// module, the breaker and the remint path. The five callers above want to post a comment,
// not to acquire that graph. This module's only non-leaf import is the install slots,
// which are themselves a zero-import leaf, so the transport can be reached from anywhere.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  getLinearWriteProxy,
  getLinearWriteProxyResolver,
} from "./linear-write-proxy-install.mjs";

/** The bash helper, resolved from THIS file's URL so it is cwd-independent (CTL-1641). */
export const COMMENT_HELPER_DEFAULT = fileURLToPath(
  new URL("../lib/linear-comment-post.sh", import.meta.url)
);

const noopLog = { warn() {}, error() {}, info() {} };

/**
 * buildCommentPayload — pure-ish. The `/agent/issue-comment` body for one comment.
 *
 * The cloud takes UUIDs, and the daemon's vocabulary is identifiers — the resolver is
 * where those become one. It is the SAME freshness-gated replica resolver the issue-field
 * routes use, so a stale replica refuses here exactly as it does there.
 */
export function buildCommentPayload(resolver, { ticket, body, parentId = null }) {
  if (typeof body !== "string" || body.trim() === "") return { ok: false, reason: "empty-body" };
  if (!resolver || typeof resolver.issue !== "function") return { ok: false, reason: "no-resolver" };
  const r = resolver.issue(ticket);
  if (!r?.ok) return { ok: false, reason: r?.reason ?? "issue-unresolved" };
  return {
    ok: true,
    payload: { issueId: r.issueId, body, ...(parentId ? { parentId } : {}) },
  };
}

/**
 * postLinearComment — post one comment, through the proxy when enforce is on.
 *
 * Returns `{ posted, via, reason }`. `via` is `"proxy"` or `"helper"`, which is what makes
 * the shadow window auditable: a host that still reports `via: "helper"` has not stopped
 * writing with its own app-actor, whatever its config claims.
 *
 * ⛔ THERE IS NO FALL-BACK TO THE HELPER ON A PROXY FAILURE, and that is the whole point.
 * Falling back would mean the host keeps posting under its own app-actor exactly when the
 * proxy is broken — so the shadow window that gates retirement would read "zero
 * host-originated writes" while the host was still writing. Every caller here already
 * retries on a later tick, and all five treat a failed comment as non-fatal.
 */
export function postLinearComment(
  ticket,
  body,
  {
    caller = null,
    parentId = null,
    proxy = undefined,
    resolver = undefined,
    runHelper = defaultRunHelper,
    log = noopLog,
  } = {}
) {
  const p = proxy !== undefined ? proxy : getLinearWriteProxy();

  // No proxy installed (mode `off`, the default) — byte-identical to pre-CTL-1889.
  if (!p) return runHelperAndReport(ticket, body, runHelper, log, caller);

  // SHADOW records the observation and lets the existing write proceed unchanged. For a
  // WRITE, "observe by doing it too" would double-post the comment, so shadow makes no
  // cloud call — the payload is deliberately not even built, since building it costs a
  // replica read that shadow would throw away.
  if (p.mode === "shadow") {
    try {
      p.send({ routeId: "comment", ticket, payload: {}, caller });
    } catch (err) {
      log?.warn?.({ ticket, caller, err: err?.message }, "linear-comment: proxy threw (shadow)");
    }
    return runHelperAndReport(ticket, body, runHelper, log, caller);
  }

  const built = buildCommentPayload(
    resolver !== undefined ? resolver : getLinearWriteProxyResolver(),
    { ticket, body, parentId }
  );
  if (!built.ok) {
    log?.warn?.(
      { ticket, caller, reason: built.reason },
      "linear-comment: could not resolve the comment — REFUSED (no direct-write fallback)"
    );
    return { posted: false, via: "proxy", reason: `resolve:${built.reason}` };
  }

  let res;
  try {
    res = p.send({ routeId: "comment", ticket, payload: built.payload, caller });
  } catch (err) {
    log?.warn?.({ ticket, caller, err: err?.message }, "linear-comment: proxy threw");
    return { posted: false, via: "proxy", reason: "proxy-threw" };
  }
  // `handled: false` can only happen for a mode this branch already excluded; treat it as
  // a refusal rather than silently reaching for the helper.
  if (!res?.handled) return { posted: false, via: "proxy", reason: res?.reason ?? "not-handled" };
  return { posted: res.applied === true, via: "proxy", reason: res.reason ?? null };
}

/** defaultRunHelper — the pre-CTL-1889 transport, unchanged. */
export function defaultRunHelper(ticket, body, helperPath = COMMENT_HELPER_DEFAULT) {
  return spawnSync(helperPath, [ticket, body], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    timeout: 30_000,
  });
}

function runHelperAndReport(ticket, body, runHelper, log, caller) {
  try {
    const res = runHelper(ticket, body);
    if (res?.status === 0) return { posted: true, via: "helper", reason: null };
    // Surface the helper's own last stderr line: it names the actual cause (token mint,
    // issue resolution, or the mutation) where a bare status code names nothing.
    const detail = String(res?.stderr || res?.error?.message || "").trim().split("\n").pop() ?? "";
    log?.warn?.({ ticket, caller, status: res?.status, detail: detail.slice(0, 200) },
      "linear-comment: helper failed");
    return { posted: false, via: "helper", reason: `helper-exit-${res?.status ?? "?"}` };
  } catch (err) {
    log?.warn?.({ ticket, caller, err: err?.message }, "linear-comment: helper threw");
    return { posted: false, via: "helper", reason: "helper-threw" };
  }
}


/**
 * postLinearCommentAsSpawnResult — compatibility adapter for the five pre-existing
 * wrappers.
 *
 * ⚠️ Each of the five call sites has its OWN wrapper with its own return contract
 * (`boolean`, `{ok, via}`, a raw spawn result), and each reads `status === 0` for success
 * and the LAST LINE of `stderr` for the diagnosis. Rewriting five different error paths in
 * one change is how a routing change becomes a behaviour change nobody meant, so this
 * returns the shape they already parse and leaves every downstream branch untouched.
 *
 * The `stderr` it synthesises is the proxy's NAMED reason, which is strictly more
 * diagnostic than the helper's last line — so the existing "surface the helper's own
 * diagnostic" logic at those sites keeps working and starts reporting `resolve:…` /
 * `budget:…` / `cloud:…` instead of a bare exit code.
 */
export function postLinearCommentAsSpawnResult(ticket, body, opts = {}) {
  const r = postLinearComment(ticket, body, opts);
  if (r.posted) return { status: 0, stdout: "", stderr: "", _via: r.via };
  return { status: 1, stdout: "", stderr: `linear-comment ${r.via}: ${r.reason ?? "failed"}`, _via: r.via };
}
