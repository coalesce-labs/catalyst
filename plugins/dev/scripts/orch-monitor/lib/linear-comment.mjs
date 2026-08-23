// linear-comment.mjs — post a REAL Linear comment, authored as the OPERATOR
// (CTL-1569 §4). This is the module the whole feature lives or dies on.
//
// ── why this is the sharpest edge in the ticket ───────────────────────────────
// CTL-1567 made a human comment on a parked ticket clear the escalation hold
// unconditionally and first. That is what makes "reply from the inbox" a real
// resolution mechanism rather than a UI gesture. But that gate requires a
// POSITIVELY-IDENTIFIED HUMAN author, and it deliberately IGNORES app-actor
// comments — that guard exists because the escalation itself posts an explanatory
// comment as the app, and without the guard the bot would clear the very label it
// had just applied.
//
// The consequence: **a reply posted as the app actor silently does nothing.** The
// comment appears in Linear, the UI looks correct, the row even disappears
// optimistically — and the ticket stays parked forever. It is the single easiest
// way to ship this feature completely inert, and it fails SILENTLY, which is the
// worst possible failure shape.
//
// So this module does not merely *hope* it holds the right token. It RESOLVES the
// token's identity and REFUSES to post as a bot:
//
//   1. Resolve `viewer` for the token actually in hand.
//   2. If that identity is an app/bot actor — or matches a configured
//      `botUserId` — REFUSE with `status:"bot_identity"` and post NOTHING.
//   3. Only then post, and return the authorship the server observed.
//
// Refusing loudly is strictly better than posting a comment that cannot resolve
// the ask: the operator sees "this would not have worked" and the row is RESTORED
// (the §4 failure-path requirement), instead of believing they answered.
//
// ── token provenance ─────────────────────────────────────────────────────────
// The personal `lin_api_*` key in the monitor's env resolves to the human operator
// (verified: → Ryan Rozich / a real Linear user). The DAEMON is the process that
// swaps in an app-actor OAuth token (catalyst-execution-core mints
// client_credentials with `actor=app` and exports LINEAR_API_TOKEN into the
// daemon's own env only). The monitor is a separate process and inherits the
// personal key — but "inherits" is an assumption about process env, exactly the
// kind that rots silently across a deploy or a launchd change. Hence the runtime
// check above rather than a comment asserting it is fine.
//
// Writes go through the Linear GraphQL API directly (not `linearis`): `linearis`
// has no "post a comment" verb this path can use without shelling per keystroke,
// and CTL-1569's own note records that `linearis --label-mode overwrite` returns a
// success payload while silently not applying — the GraphQL path is the one that
// demonstrably works for mutations. Reads stay on the replica (linear-thread.mjs).

// CTL-1616 PR3 folded the env-alias leg of the OLD single-value
// resolveLinearToken onto the shared secret-contract engine's resolveSecret().
// #19 (below) supersedes that here: this file's `linearTokenCandidates` needs
// LINEAR_API_TOKEN and LINEAR_API_KEY as two INDEPENDENT candidates (walking
// each one's identity, since they can legitimately hold different
// credentials), and resolveSecret's alias ladder collapses them to one value
// — so this file reads the two env vars directly instead of importing
// resolveSecret. Any future site here that only needs a single canonical
// value (not a multi-candidate identity walk) should still prefer
// resolveSecret("linear-api-token", ...) over a hand-rolled `??` ladder.

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";

/** Wall-clock budget for a single Linear mutation. The operator is waiting on this
 *  in a reply box, so it fails fast and restores the row rather than hanging. */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Every place a personal Linear token might be configured, in priority order,
 * deduplicated, empty/falsy entries dropped.
 *
 * ── why this cannot be env-only ──────────────────────────────────────────────
 * An env-only resolver makes this feature INERT on the normal persistent launch
 * path. `catalyst-monitor.sh` (the committed launchd wrapper) exports no Linear
 * token at all; the operator's personal token lives in the Layer-2 secrets file
 * `~/.config/catalyst/config-<projectKey>.json` under `linear.apiToken`. So a
 * launchd-started monitor would return `no_token` for every inline reply even
 * though Linear is fully configured — the same class of silent no-op the
 * authorship gate exists to prevent, arriving through a different door.
 *
 * ── why the FIRST non-empty candidate is not good enough either (2026-08-02) ──
 * `LINEAR_API_TOKEN`/`LINEAR_API_KEY` are not exclusively a personal-token slot:
 * `lib/linear-app-actor.sh` exports the APP-ACTOR's own OAuth token into these
 * exact two names for any daemon (broker/execution-core/monitor) that needs bot
 * credentials for its normal automated reads/writes — a monitor process that also
 * sources that script (as fixed for the CAT-1 liveness dashboard) will ALWAYS
 * have a non-empty `LINEAR_API_TOKEN`, but it is the bot's, not a human's. The
 * old "first non-empty string wins" resolver stopped right there and never even
 * looked at Layer-2 config, so a correctly-configured personal `linear.apiToken`
 * was permanently unreachable on such a host — not a missing-config problem, an
 * unreachable-config one. `postOperatorComment` below now walks EVERY candidate
 * this function returns and identity-checks each one, so a bot-shaped env value
 * no longer shadows a genuine personal token sitting in config.
 *
 * Order: env `LINEAR_API_TOKEN` → env `LINEAR_API_KEY` → Layer-2 `linear.apiToken`
 * → Layer-2 `catalyst.linear.apiToken` (BOTH config shapes are accepted —
 * `linear.apiToken` is what the reference schema documents
 * (website/.../reference/configuration.md) and what real installs carry, while
 * the nested `catalyst.linear.apiToken` shows up in some setups; reading only one
 * shape means a validly-configured host can still resolve nothing).
 *
 * ── the one credential we must NEVER include ─────────────────────────────────
 * The same Layer-2 file also carries `catalyst.linear.agent.accessToken` — an
 * APP-ACTOR OAuth token. Reaching for it would post the reply as the app, which
 * CTL-1567's provenance gate ignores, making the reply silently do nothing. It is
 * deliberately NOT in this list. (The authorship gate would catch it anyway if it
 * somehow got resolved to a human-looking viewer; this is the belt to that brace.)
 */
export function linearTokenCandidates(env = process.env, { projectConfig = null } = {}) {
  const candidates = [];
  const add = (v) => {
    if (typeof v !== "string") return;
    const trimmed = v.trim();
    if (trimmed !== "" && !candidates.includes(trimmed)) candidates.push(trimmed);
  };
  // CTL-1616 PR3 folded the OLD single-value `resolveLinearToken` onto
  // resolveSecret's env-alias resolver (TOKEN-before-KEY precedence, one
  // value out). That collapse is right for a caller that wants "the one
  // token", but WRONG here: this function's entire purpose (#19) is walking
  // every DISTINCT raw candidate's identity, because LINEAR_API_TOKEN and
  // LINEAR_API_KEY can legitimately hold two different credentials (e.g. a
  // bot token in one, a human's in the other) — resolveSecret would silently
  // discard whichever alias it doesn't pick, defeating the multi-candidate
  // walk. So the two env aliases stay independent entries here; resolveSecret
  // is still the right call for any site that only needs a single value.
  add(env.LINEAR_API_TOKEN);
  add(env.LINEAR_API_KEY);
  // Layer-2 personal token — the launchd path's only source. BOTH shapes are
  // accepted: `linear.apiToken` is what the reference schema documents
  // (website/.../reference/configuration.md) and what real installs carry, while
  // the nested `catalyst.linear.apiToken` shows up in some setups. Reading only
  // one shape means a validly-configured host resolves nothing and every reply
  // returns `no_token` — the failure this whole fallback exists to prevent, so it
  // is not worth being narrow about.
  add(projectConfig?.linear?.apiToken);
  add(projectConfig?.catalyst?.linear?.apiToken);
  return candidates;
}

/**
 * The single highest-priority Linear credential. Kept for any caller that only
 * ever wants "the one token" (e.g. `resolveIssueId` doesn't care about identity);
 * `postOperatorComment` uses `linearTokenCandidates` directly instead, since it
 * must try every candidate's IDENTITY, not just take the first non-empty string.
 */
export function resolveLinearToken(env = process.env, opts = {}) {
  return linearTokenCandidates(env, opts)[0] ?? null;
}

/**
 * The app-actor user ids this deployment knows about, read from the global config
 * (`~/.config/catalyst/config.json` → `catalyst.linear.bot.<app>.botUserId`).
 * These are the identities whose comments CTL-1567 ignores.
 *
 * Config-read failures return an EMPTY set, which is safe: the primary defense is
 * the `viewer` shape check below (`isMe:false` / an `organization`-less app actor),
 * and that needs no config at all. The id list is a belt-and-braces second check
 * for the case where an app token still reports a user-like viewer.
 */
export function knownBotUserIds({ config = null, projectConfig = null } = {}) {
  const ids = new Set();
  const add = (id) => {
    if (typeof id === "string" && id.trim() !== "") ids.add(id.trim());
  };
  const bots = config?.catalyst?.linear?.bot;
  if (bots && typeof bots === "object") {
    for (const app of Object.values(bots)) add(app?.botUserId);
  }
  // LEGACY per-repo form: `catalyst.monitor.linear.botUserId`, read flat from the
  // Layer-1 repo config — the shape the daemon's own self-echo guard reads. On an
  // installation that only has this form, omitting it leaves every Catalyst app
  // comment classified as HUMAN (they carry is_bot=0), which empties
  // `agentComments` and breaks the comment-derived ask.
  add(config?.catalyst?.monitor?.linear?.botUserId);
  add(projectConfig?.catalyst?.monitor?.linear?.botUserId);
  return ids;
}

/**
 * The exact text to post, given the operator's raw input.
 *
 * Trimming is used to VALIDATE emptiness, but must not rewrite what gets posted:
 * a reply that opens with a four-space-indented Markdown code block loses its
 * first line's indentation under `trim()`, and Linear then renders it as prose
 * instead of code — different semantics from what the operator wrote. So leading
 * whitespace is preserved verbatim and only trailing whitespace is dropped (which
 * is invisible in the rendered comment and never load-bearing).
 */
export function postBody(raw) {
  return typeof raw === "string" ? raw.replace(/\s+$/, "") : "";
}

/** GraphQL POST with a hard timeout. Returns the parsed body; throws on transport
 *  failure or a non-2xx. Injectable fetch keeps the unit tests offline. */
async function gql({ token, query, variables }, { fetchImpl = fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetchImpl(LINEAR_GRAPHQL_URL, {
      method: "POST",
      headers: { Authorization: token, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`non-JSON response (HTTP ${res.status})`);
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    // CTL note: Linear returns HTTP 200 with a populated `errors` array on schema
    // drift, so a 200 is NOT sufficient — the errors array must be checked too.
    if (Array.isArray(body?.errors) && body.errors.length > 0) {
      throw new Error(body.errors.map((e) => e?.message ?? String(e)).join("; "));
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

const VIEWER_QUERY = `query { viewer { id name email isMe } }`;

/**
 * Resolve who the token in hand actually is.
 *
 * Returns { ok:true, id, name, email, isMe, isBot } or { ok:false, error }.
 *
 * `isBot` is true when EITHER signal fires:
 *   • the viewer id is a configured app-actor `botUserId`, or
 *   • the viewer reports no email AND `isMe !== true` — the shape an app-actor
 *     (`actor=app`) token returns, since it is not a human workspace member.
 * A human personal key returns a real id + email + isMe:true and is never flagged.
 */
export async function resolveAuthorIdentity(
  { token, botUserIds = new Set() },
  { fetchImpl = fetch } = {},
) {
  let body;
  try {
    body = await gql({ token, query: VIEWER_QUERY, variables: {} }, { fetchImpl });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const v = body?.data?.viewer;
  if (!v || typeof v !== "object" || typeof v.id !== "string") {
    return { ok: false, error: "viewer query returned no identity" };
  }
  const hasEmail = typeof v.email === "string" && v.email !== "";
  const isBot = botUserIds.has(v.id) || (!hasEmail && v.isMe !== true);
  return {
    ok: true,
    id: v.id,
    name: typeof v.name === "string" ? v.name : null,
    email: hasEmail ? v.email : null,
    isMe: v.isMe === true,
    isBot,
  };
}

const ISSUE_ID_QUERY = `
  query ($id: String!) { issue(id: $id) { id identifier } }
`;

/**
 * Resolve a ticket KEY ("CTL-1569") to the Linear issue UUID `commentCreate` needs.
 *
 * Uses `issue(id:)`, which accepts the human identifier — deliberately NOT an
 * `IssueFilter.identifier` search: that filter field was REMOVED from the Linear
 * schema (it broke a sibling comment helper in this tree), so filtering by it
 * returns a 200 with an `errors` array rather than a match.
 */
export async function resolveIssueId({ token, ticket }, { fetchImpl = fetch } = {}) {
  let body;
  try {
    body = await gql(
      { token, query: ISSUE_ID_QUERY, variables: { id: ticket } },
      { fetchImpl },
    );
  } catch (e) {
    // Transport / auth / HTTP / GraphQL failure — NOT evidence the issue is absent.
    return { ok: false, missing: false, error: e instanceof Error ? e.message : String(e) };
  }
  const id = body?.data?.issue?.id;
  if (typeof id !== "string" || id === "") {
    // A successful query that returned no issue — a GENUINE miss.
    return { ok: false, missing: true, error: `no such issue: ${ticket}` };
  }
  return { ok: true, id };
}

const COMMENT_CREATE = `
  mutation ($issueId: String!, $body: String!) {
    commentCreate(input: { issueId: $issueId, body: $body }) {
      success
      comment {
        id
        createdAt
        user { id name email }
      }
    }
  }
`;

/** The issue-lookup + commentCreate tail, run only once a candidate token has
 *  resolved to a genuine human identity. Split out so postOperatorComment's
 *  candidate loop doesn't duplicate it per-candidate. */
async function createComment({ token, ticket, body, identity, fetchImpl, resolveIssue }) {
  const issue = await resolveIssue({ token, ticket }, { fetchImpl });
  if (!issue.ok) {
    // Only a CONFIRMED miss is `not_found`. An HTTP 500 during the lookup is a
    // retryable write failure — reporting it as "no such ticket" would hand the
    // operator a false diagnosis about their own board.
    return issue.missing === true
      ? { status: "not_found", ticket, message: issue.error }
      : { status: "error", ticket, message: `issue lookup failed: ${issue.error}` };
  }

  let result;
  try {
    result = await gql(
      { token, query: COMMENT_CREATE, variables: { issueId: issue.id, body: postBody(body) } },
      { fetchImpl },
    );
  } catch (e) {
    return { status: "error", message: e instanceof Error ? e.message : String(e) };
  }

  const payload = result?.data?.commentCreate;
  if (payload?.success !== true || typeof payload?.comment?.id !== "string") {
    return { status: "error", message: "commentCreate did not report success" };
  }

  // Report the authorship the SERVER recorded (not what we assumed) so the caller
  // can log/surface who the comment landed as.
  const user = payload.comment.user ?? null;
  return {
    status: "posted",
    ticket,
    commentId: payload.comment.id,
    createdAt: typeof payload.comment.createdAt === "string" ? payload.comment.createdAt : null,
    author: {
      id: typeof user?.id === "string" ? user.id : identity.id,
      name: typeof user?.name === "string" ? user.name : identity.name,
    },
  };
}

/**
 * Post a comment to a Linear ticket as the operator.
 *
 * Discriminated result — the route maps each to an HTTP status, and EVERY
 * non-`posted` outcome must restore the inbox row (§4):
 *
 *   { status: "posted", commentId, author }   → the comment is live and
 *                                               human-authored; CTL-1567 will
 *                                               clear the escalation hold within seconds.
 *   { status: "no_token" }                    → no Linear credential anywhere.
 *   { status: "bot_identity", author }        → REFUSED before posting: every
 *                                               configured token is an app actor,
 *                                               so the comment could not have
 *                                               resolved the ask.
 *   { status: "empty_body" }                  → nothing to say; not a Linear call.
 *   { status: "not_found", ticket }           → no such issue.
 *   { status: "error", message }              → transport / API / mutation failure.
 *
 * ── multi-candidate identity walk (2026-08-02 fix) ───────────────────────────
 * `linearTokenCandidates` may return several tokens (env AND config both set —
 * e.g. env holds the app-actor's OAuth token per `linear-app-actor.sh`, config
 * holds the operator's real personal key). Each is identity-checked IN ORDER;
 * the first one that resolves to a genuine human posts the comment. A candidate
 * that resolves to a bot is not a hard failure — it just means "try the next
 * one" — so a personal token in Layer-2 config is no longer permanently
 * shadowed by a bot token that happens to occupy the higher-priority env slot.
 * Only when EVERY candidate is exhausted (all bot, or none configured at all)
 * does this return a failure — `bot_identity` if at least one candidate
 * resolved (as a bot), `no_token` if there were no candidates to try at all.
 *
 * All collaborators are injected so every branch is unit-tested with no network.
 */
export async function postOperatorComment(
  { ticket, body },
  {
    fetchImpl = fetch,
    env = process.env,
    config = null,
    projectConfig = null,
    resolveIdentity = resolveAuthorIdentity,
    resolveIssue = resolveIssueId,
  } = {},
) {
  // Emptiness is validated on the TRIMMED value, but the body posted below is the
  // operator's verbatim text — see the postBody note.
  if (typeof body !== "string" || body.trim() === "") return { status: "empty_body" };

  const candidates = linearTokenCandidates(env, { projectConfig });
  if (candidates.length === 0) return { status: "no_token" };

  const botUserIds = knownBotUserIds({ config, projectConfig });
  let lastBotIdentity = null;
  let lastVerifyError = null;

  // ── the authorship gate ────────────────────────────────────────────────────
  // Resolve identity BEFORE mutating, for EVERY candidate in priority order. A
  // candidate that resolves to a bot is skipped (not refused) so a later, human
  // candidate still gets a chance — only exhausting the whole list is a refusal.
  for (const token of candidates) {
    const identity = await resolveIdentity({ token, botUserIds }, { fetchImpl });
    if (!identity.ok) {
      lastVerifyError = identity.error;
      continue;
    }
    if (identity.isBot) {
      lastBotIdentity = identity;
      continue;
    }
    // Found a genuine human — post with THIS token/identity, not the first
    // candidate that happened to be non-empty.
    return await createComment({ token, ticket, body, identity, fetchImpl, resolveIssue });
  }

  if (lastBotIdentity) {
    return {
      status: "bot_identity",
      author: { id: lastBotIdentity.id, name: lastBotIdentity.name },
      message:
        candidates.length > 1
          ? `refused: all ${candidates.length} configured Linear tokens resolve to an app ` +
            "actor, and CTL-1567 ignores app-actor comments — the reply would not have " +
            "cleared the escalation hold."
          : "refused: this monitor's Linear token is an app actor, and CTL-1567 ignores " +
            "app-actor comments — the reply would not have cleared the escalation hold.",
    };
  }
  // No candidate ever resolved to a bot — every one errored (network/auth/etc).
  return {
    status: "error",
    message: `could not verify comment authorship: ${lastVerifyError ?? "unknown error"}`,
  };
}
