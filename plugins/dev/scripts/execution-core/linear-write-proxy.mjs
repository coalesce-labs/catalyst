// linear-write-proxy.mjs — CTL-1889 increment 1.
//
// The host-side transport that sends a Linear WRITE to the Catalyst Cloud write
// proxy under the ONE Catalyst Cloud grant, authenticated with the PER-HOST KEY,
// instead of writing to Linear directly with this host's own app-actor.
//
// ── WHAT INCREMENT 1 IS, AND WHAT IT IS NOT ──
// IS:      a mode-gated transport (off | shadow | enforce, default off) covering the
//          three routes CTC-509 inc 2 already serves — issue-state, label, comment —
//          plus the per-host-key resolution and the LOUD no-credential refusal.
// IS NOT:  the retirement of anything. No credential, mint path, or LINEAR_* secret
//          is removed here. Retirement is gated on a shadow window with zero
//          host-originated writes, which cannot be run until this ships.
//
// ── ⛔ THE HOST SENDS NOTHING FOR IDENTITY ──
// ADR-0031 (CTC-486): the cloud derives WHICH host wrote from the per-host key it
// authenticated, not from anything in the request. So this transport deliberately
// sends NO host name, node name, hostname header, or actor field — adding one would
// re-create the two-identity confusion the ticket exists to remove, and would make
// the cloud's attribution depend on a value the host can lie about.
// `buildProxyRequest` is pure and `linear-write-proxy.test.mjs` asserts the absence
// positively (no header, no body key) rather than trusting this comment.
//
// ── WHY THE TRANSPORT IS SYNCHRONOUS ──
// `applyLabel` / `applyPhaseStatus` in linear-write.mjs are SYNCHRONOUS and are
// called from inside the scheduler's synchronous convergers (scheduler.mjs's own
// comment: "applyLabel is sync + never throws"). Making the transport async would
// mean making those async, i.e. an async refactor of schedulerTick — a cross-cutting
// change that has nothing to do with this ticket and would make the diff unreviewable.
// So the wire call is a `spawnSync` of `curl`, matching the module it interposes on,
// which already reaches Linear by spawning `linearis` and `linear-transition.sh`.
//
// ── ⛔ THE CREDENTIAL NEVER ENTERS argv, AND NEVER TOUCHES DISK ──
// `curl -H "Authorization: Bearer <tok>"` puts the token in the process table, where
// any `ps` on the host reads it. `--config <file>` puts it on disk. Both are refused.
// Every option — method, url, headers, AND body — is written to curl's stdin as a
// `--config -` document, so argv carries only `["--config","-"]` plus non-secret
// timeouts. `linear-write-proxy.test.mjs` asserts the token appears in NO argv element,
// and round-trips the config document through a REAL curl against a local server so
// the escaping is proven by observation, not by reading the escaper.
//
// ── ROUTE PATHS AND PAYLOADS ARE MEASURED, NOT ASSUMED ──
// An earlier cut of this module shipped DEFAULT_ROUTES as a declared ASSUMPTION,
// because the CTC-509 contract lives in the cloud repo and that cut could not reach it.
// It is reachable, and the assumption was wrong on every route and every payload:
// the guessed `/linear/{issue-state,label,comment}` would have 404'd, and the guessed
// bodies (`{ticket, transitionKey}`, `{ticket, mode, labels}`) would have 400'd behind
// them. Read off `apps/mirror/src/index.ts` on catalyst-cloud `origin/main` (5e852bd):
//
//   POST /api/v1/agent/issue-state    {issueId, stateId}                    → handleAgentIssueState
//   POST /api/v1/agent/issue-label    {issueId, labelIds[], mode:add|remove} → handleAgentIssueLabel
//   POST /api/v1/agent/issue-comment  {issueId, body, parentId?}            → handleAgentIssueComment
//
// Every id is a Linear UUID — see linear-write-proxy-resolve.mjs, which is where the
// daemon's identifier/name vocabulary becomes one. `mode` is `add` or `remove` ONLY:
// there is no `overwrite`, so a single-label removal sends `remove` with that one id
// rather than an overwrite carrying the remaining set.
//
// The per-route Layer-2 override (`catalyst.linearWriteProxy.routes.<route>`) is KEPT
// even though the defaults are now measured — the cloud can move a route without a
// release of this repo, and the override is what makes that a config change.
//
// ── ⚠️ THE CREDENTIAL CLASS IS PART OF THE CONTRACT ──
// These routes require a PER-HOST, ORG-OWNED WorkOS API key. The tenant-wide
// ADMIN_TOKEN authenticates (it is a machine principal) but carries no WorkOS key id,
// so the cloud refuses it by name: "credential has no per-host binding". Measured
// 2026-08-17 — mini-2 carries a real per-host key and a proxied write reached Linear;
// mini still carries the ADMIN_TOKEN and is refused. A host is therefore not made
// ready by lighting this flag alone; see the `no-cloud-token` / `unauthorized`
// refusals below, both of which are LOUD and NAMED rather than a silent fallback.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { resolveSecret } from "../lib/secret-contract.mjs";
import {
  DEFAULT_DAILY_BUDGET,
  DEFAULT_PER_TICKET_CAP,
  classifyExhaustion,
  classifyWrite,
  convergenceKeyFor,
  emptyLedger,
  markExhaustionAnnounced,
  noteConvergence,
  readLedger,
  recordWrite,
  rollToDay,
  utcDayOf,
  writeLedger,
} from "./linear-write-budget.mjs";
import { getEventLogPath, log as defaultLog } from "./config.mjs";
import { buildCatalystResource } from "./lib/catalyst-resource.mjs";

/** The three modes, house convention (cf. CLOUD_FEED_MODES / DELEGATE_FIRST_MODES). */
export const LINEAR_WRITE_PROXY_MODES = Object.freeze(new Set(["off", "shadow", "enforce"]));

/** The route ids CTC-509 inc 2 already serves. Frozen — this is DATA. */
export const PROXY_ROUTE_IDS = Object.freeze(["issue-state", "label", "comment"]);

/**
 * Measured against catalyst-cloud `origin/main` (5e852bd) — see the header. Paths are
 * relative to a base that already ends in `/api/v1` (the fleet's provisioned
 * CATALYST_CLOUD_BASE_URL). Overridable from Layer-2
 * `catalyst.linearWriteProxy.routes.<route>`.
 */
export const DEFAULT_ROUTES = Object.freeze({
  "issue-state": "/agent/issue-state",
  label: "/agent/issue-label",
  comment: "/agent/issue-comment",
});

/** Mirrors cloud-sync.mjs:127 — one default, one env override, no third rung. */
export const DEFAULT_CLOUD_BASE_URL = "https://api.catalyst-cloud.coalescelabs.ai/api/v1";

/**
 * Hard cap on the serialized request body, byte length. Over it the write is
 * REFUSED with a named reason — never truncated, never split. Same posture and
 * same number as the event-log append cap (CTL-1809): a silently truncated Linear
 * comment is worse than a loud refusal, and curl's config parser is the wrong place
 * to discover a size limit.
 */
export const MAX_BODY_BYTES = 262_144;

/** Wire timeouts. Non-secret, so they ride argv rather than the stdin config. */
export const CONNECT_TIMEOUT_SEC = 5;
export const MAX_TIME_SEC = 20;

/**
 * scrub — strip any secret-shaped substring before it can reach a log line.
 * Lifted from cloud-sync.mjs:226-234 rather than re-derived, so the two agree.
 */
export function scrub(s) {
  return String(s)
    .replace(/([?&]token=)[^&\s"']+/gi, "$1***")
    .replace(/\bBearer\s+[A-Za-z0-9._-]+/gi, "Bearer ***")
    .replace(/\blin_(?:api|oauth)_[A-Za-z0-9_-]+/g, "lin_***");
}

/**
 * resolveProxyBaseUrl — the cloud API base, same two-rung shape cloud-sync.mjs uses.
 * A trailing slash is trimmed so route concatenation is unambiguous.
 */
export function resolveProxyBaseUrl(env = process.env) {
  const raw = env?.CATALYST_CLOUD_BASE_URL || DEFAULT_CLOUD_BASE_URL;
  return String(raw).replace(/\/+$/, "");
}

/**
 * resolveHostKey — the per-host key, THROUGH the existing secret contract.
 *
 * ⛔ Deliberately NOT a new registered row and NOT a hand-rolled env ladder. The
 * `cloud-token` row (delivery `platform-env`, bootstrapFor `cloud`) already IS the
 * per-host key: configuration.md states "the per-host-ness is the VALUE you provision,
 * not the name". Hardcoding `CATALYST_CLOUD_TOKEN` here would silently ignore a host
 * whose operator set `CATALYST_CLOUD_TOKEN_ENV` / Layer-2 `catalyst.cloud.tokenEnv`.
 *
 * Returns the contract's shape plus its `envVar`/`envVarSource` extras, with the
 * value present or null — never a throw, per the contract's own never-throws rule.
 */
export function resolveHostKey(env = process.env) {
  try {
    const r = resolveSecret("cloud-token", { env });
    return {
      value: typeof r?.value === "string" && r.value.length > 0 ? r.value : null,
      source: r?.source ?? "none",
      envVar: r?.envVar ?? null,
      envVarSource: r?.envVarSource ?? null,
    };
  } catch {
    // The contract promises never to throw; if it somehow does, that is "no key",
    // which routes to the loud refusal below rather than to a direct Linear write.
    return { value: null, source: "none", envVar: null, envVarSource: null };
  }
}

/**
 * resolveRoutePath — the path for one route id, Layer-2 override over the default.
 * Returns null for an unknown route id or a non-absolute override, so an enforce
 * caller refuses with `unknown-route` instead of POSTing to a fabricated URL.
 */
export function resolveRoutePath(routeId, routes = null) {
  if (!PROXY_ROUTE_IDS.includes(routeId)) return null;
  const override = routes && typeof routes === "object" ? routes[routeId] : undefined;
  if (typeof override === "string" && override.startsWith("/")) return override;
  return DEFAULT_ROUTES[routeId];
}

/**
 * resolveProxyAccount — the tenant id, same env the replica writer already reads
 * (`CATALYST_CLOUD_ACCOUNT`, provisioned beside the token in cloud-sync.env).
 * Returns null when unset — see buildProxyRequest for why that is not an error.
 */
export function resolveProxyAccount(env = process.env) {
  const raw = env?.CATALYST_CLOUD_ACCOUNT;
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
}

/**
 * buildProxyRequest — pure. { url, method, body } for one write.
 *
 * ⛔ `body` carries the WRITE and nothing else. No host, no node name, no actor.
 * See the header: identity is the key, not the payload. (The cloud accepts an optional
 * body `hostId` and compares it to the credential's display label as a NON-blocking
 * diagnostic — we deliberately still send nothing, because a field the cloud logs a
 * mismatch WARNING for and then ignores is a field that can only add noise.)
 *
 * ── WHY `?account=` IS SENT WHEN KNOWN, AND WHY ITS ABSENCE IS NOT AN ERROR ──
 * For a correct per-host org key the cloud DEFAULTS the account to the key's own, so
 * omitting the parameter is already correct and a host with no `CATALYST_CLOUD_ACCOUNT`
 * still works. Sending it buys DIAGNOSIS, not function: a host mis-provisioned with the
 * tenant-wide ADMIN_TOKEN gets the specific 403 "credential has no per-host binding"
 * instead of the generic 401 "missing account", which names the actual defect. The one
 * cost is that a *wrong* account value turns a working key into a 403 — acceptable,
 * because that too is loud, and the account is provisioned from the same bundle as the
 * token it accompanies.
 */
export function buildProxyRequest({ routeId, payload, baseUrl, routes = null, account = null }) {
  const path = resolveRoutePath(routeId, routes);
  if (path === null) return { url: null, method: null, body: null, reason: "unknown-route" };
  const query = account ? `?account=${encodeURIComponent(account)}` : "";
  return {
    url: `${baseUrl}${path}${query}`,
    method: "POST",
    body: JSON.stringify(payload ?? {}),
    reason: null,
  };
}

/**
 * curlConfigEscape — escape a value for curl's double-quoted config syntax.
 *
 * curl un-escapes exactly `\\`, `\"`, `\t`, `\n`, `\r`, `\v` inside a quoted config
 * value. So escaping backslash FIRST and then the quote is sufficient AND necessary:
 * JSON.stringify already emits control characters as the two-character sequences
 * `\` + `n`, and without the backslash doubling curl would collapse that pair back
 * into a real newline and corrupt the JSON. Order matters — quote-first would
 * re-escape the backslashes it just introduced.
 */
export function curlConfigEscape(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * buildCurlConfig — the `--config -` document handed to curl on stdin.
 * Pure, so the "no secret in argv" property is testable without running curl.
 */
export function buildCurlConfig({ url, method, token, body }) {
  return (
    [
      `request = "${curlConfigEscape(method)}"`,
      `url = "${curlConfigEscape(url)}"`,
      `header = "Authorization: Bearer ${curlConfigEscape(token)}"`,
      'header = "Content-Type: application/json"',
      'header = "Accept: application/json"',
      `data = "${curlConfigEscape(body)}"`,
      "silent",
      "show-error",
      // Trailing "\n<code>" so the caller can split the status off the body without
      // a second request or a header dump that would echo the Authorization line.
      'write-out = "\\n%{http_code}"',
    ].join("\n") + "\n"
  );
}

/**
 * classifyProxyResponse — pure. Map a transport result to a tagged verdict.
 *
 * reason values (every non-applied path is NAMED — a bare false is not a diagnosis):
 *   null              — applied
 *   "spawn-failed"    — curl could not be executed at all
 *   "transport-error" — curl ran but the request did not complete (non-zero exit)
 *   "unauthorized"    — 401/403: the per-host key is rejected by the cloud
 *   "not-found"       — 404: the route does not exist (see the header's route caveat)
 *   "rate-limited"    — 429
 *   "server-error"    — 5xx, retry next tick
 *   "rejected"        — any other non-2xx
 *   "unreadable"      — 2xx that carried no parseable status line
 */
export function classifyProxyResponse({ code, stdout, stderr } = {}) {
  if (code === 127) return { applied: false, reason: "spawn-failed", status: null };
  const text = typeof stdout === "string" ? stdout : "";
  const nl = text.lastIndexOf("\n");
  const statusRaw = nl === -1 ? text : text.slice(nl + 1);
  const status = /^\d{3}$/.test(statusRaw.trim()) ? Number(statusRaw.trim()) : null;
  const bodyText = nl === -1 ? "" : text.slice(0, nl);
  if (code !== 0) {
    return { applied: false, reason: "transport-error", status, body: bodyText, stderr: scrub(stderr ?? "") };
  }
  if (status === null) return { applied: false, reason: "unreadable", status: null, body: bodyText };

  // ⛔ THE VERDICT COMES FROM THE BODY'S `outcome`, NOT FROM THE STATUS CODE ALONE.
  // CTC-509 returns a discriminated outcome (`succeeded` | `rejected` | `exhausted`,
  // plus `failed` for a partly-applied label batch) and the status is DERIVED from it.
  // Reading only the status would collapse two different things a 2xx can mean — and
  // for the label route a 200 is emitted only when EVERY id succeeded, so a body that
  // says otherwise is exactly the case where trusting the code would report a write we
  // did not get. The body's own `reason` is also far more diagnostic than a re-derived
  // one, so it is carried through verbatim (scrubbed) rather than replaced.
  const parsed = parseProxyBody(bodyText);
  if (parsed && typeof parsed.outcome === "string") {
    if (parsed.outcome === "succeeded") {
      // CTL-1936 / AC3: CTC-674 made an already-absent label removal answer 200
      // `already-absent` instead of 400. That is correct — and it silently removed the
      // only brake the host had, because the CTL-1078 back-off counts FAILURES and this
      // is a success. Surface convergence as its own fact so the caller can stop
      // re-issuing, WITHOUT calling it a failure: folding it into the failure counter
      // would restore the throttle by re-introducing a lie.
      const results = Array.isArray(parsed.results) ? parsed.results : null;
      const converged =
        results !== null && results.length > 0 && results.every((r) => r?.outcome === "already-absent");
      return { applied: true, reason: null, status, body: bodyText, converged };
    }
    const named = typeof parsed.reason === "string" && parsed.reason.trim() !== ""
      ? scrub(parsed.reason).slice(0, 300)
      : parsed.outcome;
    return { applied: false, reason: `cloud:${parsed.outcome}`, detail: named, status, body: bodyText };
  }

  // No parseable outcome — fall back to the status class. A 2xx here is NOT called
  // applied: these routes always answer with an outcome, so a 2xx without one means we
  // are not talking to the route we think we are (a proxy/redirect/HTML error page),
  // and "assume it worked" is the one reading a write path may never take.
  if (status >= 200 && status < 300) return { applied: false, reason: "unreadable-outcome", status, body: bodyText };
  if (status === 401 || status === 403) return { applied: false, reason: "unauthorized", status, body: bodyText };
  if (status === 404) return { applied: false, reason: "not-found", status, body: bodyText };
  if (status === 429) return { applied: false, reason: "rate-limited", status, body: bodyText };
  if (status >= 500) return { applied: false, reason: "server-error", status, body: bodyText };
  return { applied: false, reason: "rejected", status, body: bodyText };
}

/** parseProxyBody — JSON.parse or null. Never throws; a non-object is not an outcome. */
export function parseProxyBody(bodyText) {
  if (typeof bodyText !== "string" || bodyText.trim() === "") return null;
  try {
    const v = JSON.parse(bodyText);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * defaultHttpFn — the real wire call. `spawnSync` of curl with the whole option
 * document (including the bearer token) on stdin. Returns rawExec's shape.
 *
 * `/usr/bin/curl` is absolute for the same reason `/bin/dd` is in lib/canonical-event.sh:
 * a restricted-PATH worker is exactly where a PATH-resolved helper becomes a silent
 * no-op, and the test harness fronts PATH with a fake-bin directory.
 */
export const CURL_BIN = "/usr/bin/curl";

export function defaultHttpFn({ url, method, token, body }) {
  const config = buildCurlConfig({ url, method, token, body });
  // argv carries NO secret — only the config sentinel and non-secret timeouts.
  const args = [
    "--config",
    "-",
    "--connect-timeout",
    String(CONNECT_TIMEOUT_SEC),
    "--max-time",
    String(MAX_TIME_SEC),
  ];
  const res = spawnSync(CURL_BIN, args, { encoding: "utf8", input: config });
  if (res.error) return { code: 127, stdout: "", stderr: res.error.message, args };
  return { code: res.status ?? 0, stdout: res.stdout ?? "", stderr: res.stderr ?? "", args };
}

// ─── Observability ───────────────────────────────────────────────────────────
//
// Three names, not one name plus a payload flag — the CTL-1659 rule: otel-forward
// strips body.payload off-machine, so an alert must be able to select "a host really
// wrote through the proxy" from `attributes` alone. Registered in
// broker/namespace-parity.test.mjs by IMPORT, never a re-typed literal.

export const EVENT_WOULD_WRITE = "linear.write.proxy.would-write";
export const EVENT_APPLIED = "linear.write.proxy.applied";
export const EVENT_FAILED = "linear.write.proxy.failed";
/** CTL-1936 / AC5 — raised ONCE per exhaustion episode, never once per refused write. */
export const EVENT_EXHAUSTED = "linear.write.proxy.budget-exhausted";
export const PROXY_EVENT_NAMES = Object.freeze([EVENT_WOULD_WRITE, EVENT_APPLIED, EVENT_FAILED, EVENT_EXHAUSTED]);

/** Default ledger location. One file per host; the daemon and any CLI share it. */
export function defaultBudgetPath(env = process.env) {
  const home = env.HOME || "";
  return `${env.CATALYST_DIR || `${home}/catalyst`}/linear-write-budget.json`;
}

/**
 * buildProxyEvent — a v2 envelope for one proxy decision. Cloned from
 * linear-state-write-event.mjs (CTL-757) so the two audit families agree on
 * channel / actor / stream_class rather than each inventing their own.
 */
/**
 * CTL-1936 / AC4 — `caller` and `labels`.
 *
 * The incident could not be attributed from the event stream: the payload carried
 * `{ticket, route, mode, applied}` and NOT the label name or the calling site, so 302
 * writes on one ticket could not be traced to what issued them. `daemon.log` had rotated
 * and retained one line. Both fields are also promoted to attributes, because
 * otel-forward strips `body.payload` off-machine — a field only in the payload is
 * invisible to exactly the operator asking this question from Loki.
 */
export function buildProxyEvent({
  name,
  ticket,
  routeId,
  mode,
  reason = null,
  status = null,
  applied = false,
  caller = null,
  labels = null,
}) {
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  return (
    JSON.stringify({
      ts,
      id: randomBytes(8).toString("hex"),
      observedTs: ts,
      severityText: name === EVENT_FAILED ? "ERROR" : "INFO",
      severityNumber: name === EVENT_FAILED ? 17 : 9,
      traceId: randomBytes(16).toString("hex"),
      spanId: randomBytes(8).toString("hex"),
      channel: "execution-core",
      resource: buildCatalystResource({ serviceName: "catalyst.execution-core" }),
      attributes: {
        "event.name": ticket ? `${name}.${ticket}` : name,
        "event.stream_class": "coordination",
        "event.entity": "linear",
        "event.action": "write-proxy",
        "event.label": ticket ?? routeId,
        "event.channel": "execution-core",
        "linear.issue.identifier": ticket ?? undefined,
        "catalyst.linear_write_proxy.route": routeId,
        "catalyst.linear_write_proxy.mode": mode,
        "catalyst.linear_write_proxy.reason": reason ?? undefined,
        "catalyst.linear_write_proxy.status": status ?? undefined,
        "catalyst.linear_write_proxy.caller": caller ?? undefined,
        "catalyst.linear_write_proxy.labels": Array.isArray(labels) ? labels.join(",") : (labels ?? undefined),
      },
      body: {
        payload: {
          ticket: ticket ?? null,
          route: routeId,
          mode,
          applied,
          reason,
          status,
          caller: caller ?? null,
          labels: labels ?? null,
        },
      },
    }) + "\n"
  );
}

function defaultAppendEvent(line) {
  const logPath = getEventLogPath();
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, line);
}

/**
 * createLinearWriteProxy — the installed transport, or NULL.
 *
 * ⛔ `off` INSTALLS NOTHING. Returning null (rather than an inert object) is what
 * makes the merge a strict no-op: linear-write.mjs's `routeThroughProxy` short-circuits
 * on a null proxy before it resolves a key, reads config, or emits anything. The check
 * is a positive allow-list, so a garbage mode that got past the resolver also installs
 * nothing.
 */
export function createLinearWriteProxy({
  mode = "off",
  env = process.env,
  routes = null,
  httpFn = defaultHttpFn,
  appendEvent = defaultAppendEvent,
  log = defaultLog,
  // CTL-1936. Seams, so the throttle is testable without a filesystem.
  budgetPath = null,
  nowFn = () => Date.now(),
  readLedgerFn = readLedger,
  writeLedgerFn = writeLedger,
} = {}) {
  if (mode !== "shadow" && mode !== "enforce") return null;

  const baseUrl = resolveProxyBaseUrl(env);
  const account = resolveProxyAccount(env);
  const counts = { wouldWrite: 0, applied: 0, failed: 0, refused: 0 };

  // ── CTL-1936: the host's own spend ledger ──
  //
  // ⚠️ SINGLE-WRITER BY CONSTRUCTION, and that is an assumption worth stating rather
  // than a lock worth building. The ledger is a read-modify-write with no file lock, so
  // two concurrent writers would lose counts. `createLinearWriteProxy` has exactly ONE
  // non-test call site — daemon.mjs — and the daemon's scheduler tick is synchronous, so
  // there is one writer per host today. If a second call site ever appears (a CLI, a
  // second daemon), this needs a lock, and losing counts fails toward UNDER-counting,
  // i.e. toward the pre-CTL-1936 behaviour rather than toward wrongly throttling a
  // healthy host.
  //
  // ⚠️ A degraded (unusable) ledger also disables CONVERGENCE suppression, not just the
  // cap — `classifyWrite` is skipped entirely. That is the same fail-open direction: the
  // worst case is the cloud answering `already-absent` again, which is a wasted call, not
  // a wrong board state.
  const ledgerPath = budgetPath ?? defaultBudgetPath(env);
  const dailyBudget = Number(env.CATALYST_LINEAR_WRITE_DAILY_BUDGET) || DEFAULT_DAILY_BUDGET;
  const perTicketCap = Number(env.CATALYST_LINEAR_WRITE_TICKET_CAP) || DEFAULT_PER_TICKET_CAP;

  /**
   * loadLedger — read, then roll to today.
   *
   * ⛔ An UNUSABLE ledger (present but unreadable/corrupt) fails OPEN — the write is
   * allowed — and says so loudly. That direction is deliberate and is the opposite of
   * the restart-budget case: failing closed here would turn one corrupt file into a
   * TOTAL Linear-write outage for the host, which is strictly worse than the runaway
   * this guard exists to bound (the cloud's own 429 still backstops that). What must not
   * happen is failing open SILENTLY, so the degradation is named every time.
   */
  const loadLedger = () => {
    const day = utcDayOf(nowFn());
    const r = readLedgerFn(ledgerPath);
    if (r.state === "loaded") return { ledger: rollToDay(r.ledger, day), degraded: false };
    if (r.state === "fresh") return { ledger: emptyLedger(day), degraded: false };
    log?.warn?.(
      { path: ledgerPath, reason: r.reason },
      "linear-write-proxy: write-budget ledger unusable — allowing the write, but this host's spend is NOT being bounded"
    );
    return { ledger: emptyLedger(day), degraded: true };
  };

  const persist = (ledger) => {
    try {
      writeLedgerFn(ledgerPath, ledger);
    } catch (err) {
      // Never let bookkeeping fail a write that already happened.
      log?.warn?.({ err: scrub(err?.message ?? "") }, "linear-write-proxy: budget ledger write failed");
    }
  };

  const emit = (name, fields) => {
    try {
      appendEvent(buildProxyEvent({ name, mode, ...fields }));
    } catch (err) {
      // Emission must never mask or block the write decision it reports.
      log?.warn?.({ err: scrub(err?.message ?? "") }, "linear-write-proxy: event append failed");
    }
  };

  return {
    mode,
    baseUrl,
    account,
    counts: () => ({ ...counts }),

    /**
     * send — route one write.
     *
     * SHADOW returns `{ handled: false }`: the caller performs its existing direct
     * write, unchanged, and the observation is recorded. Shadow deliberately makes NO
     * cloud call — for a WRITE, "observe by doing it too" would double-write the board.
     *
     * ENFORCE returns `{ handled: true, applied, reason }`: the proxy IS the write.
     * ⛔ There is NO fall-back to the direct path on failure. A fall-back would mean
     * the host keeps writing with its own app-actor exactly when the proxy is broken —
     * i.e. the shadow window would read "zero host-originated writes" while the host
     * was still writing. Every caller here already retries on the next tick.
     */
    send({ routeId, ticket = null, payload = {}, caller = null }) {
      // CTL-1936 / AC4: what the operator needs to attribute a write. Derived here so
      // every emit below carries it without each call site remembering to.
      const labels = Array.isArray(payload?.labelIds) ? payload.labelIds : null;
      const convergenceKey = convergenceKeyFor({ routeId, ticket, payload });

      if (mode === "shadow") {
        counts.wouldWrite += 1;
        emit(EVENT_WOULD_WRITE, { ticket, routeId, reason: "shadow", applied: false, caller, labels });
        return { handled: false, applied: false, reason: "shadow" };
      }

      const fail = (reason, status = null, detail = null) => {
        counts.failed += 1;
        emit(EVENT_FAILED, { ticket, routeId, reason, status, applied: false, caller, labels });
        log?.warn?.(
          { ticket, route: routeId, reason, status, detail: detail ? scrub(detail) : undefined },
          "linear-write-proxy: write NOT applied — refusing to fall back to a direct Linear write"
        );
        // `detail` is OMITTED rather than set to null when there is none, so the
        // returned shape stays exactly what a caller must handle and the tests can keep
        // asserting it with toEqual instead of toMatchObject.
        return { handled: true, applied: false, reason, ...(detail ? { detail } : {}) };
      };

      // ── CTL-1936 / AC2 + AC3: refuse LOCALLY, before any cloud call ──
      // The runaway spent 302 of 307 writes on one ticket. A refusal here costs nothing,
      // where a refusal at the cloud costs a budget unit — which is how the whole day's
      // budget went in 13 minutes. `refused` is its own counter: it is not a failed
      // write, and it is not an applied one.
      const { ledger: ledgerBefore, degraded: ledgerDegraded } = loadLedger();
      if (!ledgerDegraded) {
        const gate = classifyWrite({ ledger: ledgerBefore, ticket, convergenceKey, dailyBudget, perTicketCap });
        if (!gate.allow) {
          counts.refused += 1;
          emit(EVENT_FAILED, { ticket, routeId, reason: gate.reason, status: null, applied: false, caller, labels });
          log?.warn?.(
            { ticket, route: routeId, caller, labels, reason: gate.reason, spentForTicket: gate.spentForTicket, total: gate.total },
            "linear-write-proxy: write refused by the HOST budget — not sent to the cloud"
          );
          return { handled: true, applied: false, reason: gate.reason };
        }
      }

      const req = buildProxyRequest({ routeId, payload, baseUrl, routes, account });
      if (req.reason) return fail(req.reason);

      // ⛔ THE LOUD NO-CREDENTIAL REFUSAL (the ticket's negative control). A host in
      // enforce with no per-host key must fail with a NAMED reason, never degrade to
      // a direct Linear write and never look like a success.
      const key = resolveHostKey(env);
      if (key.value === null) {
        log?.error?.(
          { ticket, route: routeId, token_env: key.envVar, token_env_source: key.envVarSource },
          "linear-write-proxy: no per-host cloud key — Linear write REFUSED (reason=no-cloud-token)"
        );
        return fail("no-cloud-token");
      }

      const bytes = Buffer.byteLength(req.body, "utf8");
      if (bytes > MAX_BODY_BYTES) {
        log?.error?.({ ticket, route: routeId, bytes, cap: MAX_BODY_BYTES },
          "linear-write-proxy: body over cap — write REFUSED, never truncated");
        return fail("body-too-large");
      }

      let raw;
      try {
        raw = httpFn({ url: req.url, method: req.method, token: key.value, body: req.body });
      } catch (err) {
        log?.warn?.({ ticket, route: routeId, err: scrub(err?.message ?? "") },
          "linear-write-proxy: transport threw");
        return fail("spawn-failed");
      }

      const verdict = classifyProxyResponse(raw);

      // The write LEFT this host, so it spent budget — success or not. Counting only
      // successes would let a failing loop spend the day invisibly, which is the exact
      // shape of the incident before CTC-674 changed the status code.
      let ledgerAfter = recordWrite(ledgerBefore, ticket);
      if (verdict.converged) ledgerAfter = noteConvergence(ledgerAfter, convergenceKey);
      const exhaustion = classifyExhaustion(ledgerAfter, { dailyBudget });
      if (exhaustion.announce) {
        ledgerAfter = markExhaustionAnnounced(ledgerAfter);
        emit(EVENT_EXHAUSTED, { ticket, routeId, reason: "budget:day-exhausted", status: null, applied: false, caller, labels });
        log?.error?.(
          { total: ledgerAfter.total, dailyBudget, day: ledgerAfter.day },
          "linear-write-proxy: host daily cloud write budget EXHAUSTED — every further Linear write is refused until the UTC day rolls"
        );
      }
      if (!ledgerDegraded) persist(ledgerAfter);

      if (!verdict.applied) return fail(verdict.reason, verdict.status, verdict.detail ?? null);
      counts.applied += 1;
      emit(EVENT_APPLIED, { ticket, routeId, reason: null, status: verdict.status, applied: true, caller, labels });
      return { handled: true, applied: true, reason: null, status: verdict.status };
    },
  };
}
