// linear-write-proxy.test.mjs — CTL-1889 increment 1.
// Run: cd plugins/dev/scripts/execution-core && bun test linear-write-proxy.test.mjs
//
// Coverage discipline: every mode × outcome cell is PINNED, not sampled, and every
// suppression / absence claim carries an explicit NEGATIVE CONTROL that proves the
// instrument can see the thing when it IS present.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CURL_BIN,
  DEFAULT_CLOUD_BASE_URL,
  DEFAULT_ROUTES,
  EVENT_APPLIED,
  EVENT_FAILED,
  EVENT_WOULD_WRITE,
  LINEAR_WRITE_PROXY_MODES,
  MAX_BODY_BYTES,
  PROXY_EVENT_NAMES,
  NON_BLOCKING_ROUTE_IDS,
  PROXY_ROUTE_IDS,
  READ_ROUTE_IDS,
  buildCurlConfig,
  buildProxyRequest,
  classifyProxyResponse,
  createLinearWriteProxy,
  curlConfigEscape,
  defaultHttpFn,
  resolveHostKey,
  resolveProxyBaseUrl,
  resolveRoutePath,
  scrub,
} from "./linear-write-proxy.mjs";

const TOKEN = "ctok_live_abcdef0123456789";
const envWithKey = (extra = {}) => ({ CATALYST_CLOUD_TOKEN: TOKEN, ...extra });

/** A recording transport. Never touches the network. */
function recorder(result = { code: 0, stdout: "{}\n200", stderr: "" }) {
  const calls = [];
  const fn = (req) => {
    calls.push(req);
    return typeof result === "function" ? result(req) : result;
  };
  fn.calls = calls;
  return fn;
}

/** A recording event sink; returns the parsed envelopes. */
function eventSink() {
  const lines = [];
  const fn = (line) => lines.push(line);
  fn.events = () => lines.map((l) => JSON.parse(l));
  fn.names = () => fn.events().map((e) => e.attributes["event.name"]);
  return fn;
}

const silentLog = { info() {}, warn() {}, error() {} };

describe("mode contract", () => {
  test("the mode set is exactly the three house modes", () => {
    expect([...LINEAR_WRITE_PROXY_MODES].sort()).toEqual(["enforce", "off", "shadow"]);
  });

  test.each([undefined, null, "", "off", "OFF", "ENFORCE", "enforce ", "on", "1", "true", 42, {}])(
    "mode %p installs NOTHING (returns null, not an inert object)",
    (mode) => {
      expect(createLinearWriteProxy({ mode, env: envWithKey() })).toBeNull();
    },
  );

  test("NEGATIVE CONTROL: the two real modes DO install, so the null above is a decision not a broken factory", () => {
    expect(createLinearWriteProxy({ mode: "shadow", env: envWithKey() })).not.toBeNull();
    expect(createLinearWriteProxy({ mode: "enforce", env: envWithKey() })).not.toBeNull();
  });

  test("off resolves no key and emits nothing — proven by seams that would record it", () => {
    const http = recorder();
    const emit = eventSink();
    expect(createLinearWriteProxy({ mode: "off", env: envWithKey(), httpFn: http, appendEvent: emit })).toBeNull();
    expect(http.calls).toHaveLength(0);
    expect(emit.names()).toEqual([]);
  });
});

describe("resolveProxyBaseUrl", () => {
  test("defaults to the cloud API base cloud-sync.mjs uses", () => {
    expect(resolveProxyBaseUrl({})).toBe(DEFAULT_CLOUD_BASE_URL);
  });
  test("CATALYST_CLOUD_BASE_URL overrides, trailing slashes trimmed", () => {
    expect(resolveProxyBaseUrl({ CATALYST_CLOUD_BASE_URL: "http://h:1/api/v1//" })).toBe("http://h:1/api/v1");
  });
  test("an empty override falls back to the default rather than producing a bare path", () => {
    expect(resolveProxyBaseUrl({ CATALYST_CLOUD_BASE_URL: "" })).toBe(DEFAULT_CLOUD_BASE_URL);
  });
});

describe("resolveHostKey — through the secret contract, not a hand-rolled ladder", () => {
  test("reads the cloud-token row's default env var", () => {
    const k = resolveHostKey({ CATALYST_CLOUD_TOKEN: TOKEN });
    expect(k.value).toBe(TOKEN);
    expect(k.envVar).toBe("CATALYST_CLOUD_TOKEN");
    expect(k.envVarSource).toBe("default");
  });

  test("⭐ honours the operator's NAME override — the thing a hardcoded env read would miss", () => {
    // This is the whole reason resolveHostKey delegates to resolveSecret("cloud-token").
    const k = resolveHostKey({ CATALYST_CLOUD_TOKEN_ENV: "MY_HOST_KEY", MY_HOST_KEY: TOKEN });
    expect(k.value).toBe(TOKEN);
    expect(k.envVar).toBe("MY_HOST_KEY");
    expect(k.envVarSource).toBe("env");
  });

  test("NEGATIVE CONTROL: with the override set but the named var empty, the value is null (and the default var is NOT consulted)", () => {
    const k = resolveHostKey({ CATALYST_CLOUD_TOKEN_ENV: "MY_HOST_KEY", CATALYST_CLOUD_TOKEN: TOKEN });
    expect(k.value).toBeNull();
    expect(k.envVar).toBe("MY_HOST_KEY");
  });

  test("absent key resolves to null, never to a placeholder or empty string", () => {
    expect(resolveHostKey({}).value).toBeNull();
    expect(resolveHostKey({ CATALYST_CLOUD_TOKEN: "" }).value).toBeNull();
  });
});

describe("routes", () => {
  test("the supported routes are exactly the set below — fails in both directions", () => {
    // CTL-1943 added `session` (CTC-682); CTL-1889 inc 3 added `attachment` (CTC-692) — the
    // cluster fence + heartbeat record. The exact-equality shape is deliberate: a new route
    // must be argued for HERE, because every id in this set is a path the daemon will send a
    // Linear write to.
    //
    // CTL-1961 adds two, and the argument for each:
    //   `reaction`     (CTC-724) — the 👀 read-receipt `linear-ack.mjs` leaves on a human's
    //                  comment and `linear-reply.mjs` clears once it has replied. Today both
    //                  tools POST `reactionCreate`/`reactionDelete` straight to
    //                  api.linear.app with a host-held credential; routing them is the
    //                  point of the skinny-install gate.
    //   `issue-create` (CTC-725) — filing a ticket, which every lane does. Returns the
    //                  `identifier`, so "file the ticket before citing its number" is served
    //                  by the call rather than a follow-up read.
    // Both paths were read off catalyst-cloud's DISPATCHER (index.ts:986/989 — the pathname
    // the server compares), not the handler doc comments, per this module's own header.
    const expected = ["attachment", "comment", "issue-create", "issue-state", "label", "reaction", "session"];
    expect([...PROXY_ROUTE_IDS].sort()).toEqual(expected);
    expect(Object.keys(DEFAULT_ROUTES).sort()).toEqual(expected);
    // The READ routes are a SEPARATE set on purpose (they spend no write budget), and they
    // must not leak into the write set — asserted in both directions.
    expect([...READ_ROUTE_IDS].sort()).toEqual(["attachments"]);
  });

  // ── CTL-1961: the two routes that let a credential-free host ack and file ──────────
  test("reaction + issue-create resolve to the paths the SERVER matches on", () => {
    // Measured at catalyst-cloud origin/main (ba3a722) index.ts:986/989 —
    //   url.pathname === "/api/v1/agent/reaction"
    //   url.pathname === "/api/v1/agent/issue-create"
    // The client's base already ends in /api/v1, so these are the remainders. Pinned
    // because this module's header records an earlier cut that shipped GUESSED paths and
    // was wrong on every one of them.
    expect(resolveRoutePath("reaction")).toBe("/agent/reaction");
    expect(resolveRoutePath("issue-create")).toBe("/agent/issue-create");
  });

  test("⛔ reaction is BLOCKING — the add/remove pair would otherwise strand a stale 👀", () => {
    // The reason is NOT "a claim decides whether a host may work a ticket" (CTC-724's
    // wording): the 👀 is a read-receipt on one comment, not a claim — the exclusion
    // primitive is the `attachment` fence. The reason that survives is an ordering race:
    // `linear-ack.mjs` ADDS and `linear-reply.mjs` REMOVES, on the same object, seconds
    // apart. Fire-and-forget on the add lets the remove run first, find nothing, and the
    // add land after it — a permanent stale 👀 on an already-answered comment that
    // nothing ever clears.
    expect(NON_BLOCKING_ROUTE_IDS.has("reaction")).toBe(false);
    expect(NON_BLOCKING_ROUTE_IDS.has("issue-create")).toBe(false);
  });

  test("both are WRITE routes — they spend budget and must not leak into the read set", () => {
    expect(READ_ROUTE_IDS.has("reaction")).toBe(false);
    expect(READ_ROUTE_IDS.has("issue-create")).toBe(false);
    expect(PROXY_ROUTE_IDS).toContain("reaction");
    expect(PROXY_ROUTE_IDS).toContain("issue-create");
  });

  test("⛔ exactly ONE route is non-blocking, and it is not a dispatch-critical one", () => {
    // The asymmetry COORD-122 decided. Asserted as an exact set so a future id cannot be
    // added to the fast path without this failing — the three routes below each carry a
    // decision the daemon reads back, so "sent and forgotten" would mean believing a
    // board state that was never achieved.
    expect([...NON_BLOCKING_ROUTE_IDS]).toEqual(["session"]);
    for (const id of ["issue-state", "label", "comment"]) {
      expect(NON_BLOCKING_ROUTE_IDS.has(id)).toBe(false);
    }
  });

  test("a Layer-2 override wins over the shipped default", () => {
    expect(resolveRoutePath("label", { label: "/v2/linear/labels" })).toBe("/v2/linear/labels");
  });

  test("a non-absolute or non-string override is IGNORED, not concatenated", () => {
    expect(resolveRoutePath("label", { label: "linear/labels" })).toBe(DEFAULT_ROUTES.label);
    expect(resolveRoutePath("label", { label: 7 })).toBe(DEFAULT_ROUTES.label);
  });

  test("an unknown route id yields null → buildProxyRequest refuses with a named reason", () => {
    // ⚠️ This test used to use "attachment" as its example of an unknown route. CTL-1889
    // inc 3 made that a REAL route, and the assertion inverted — so the id here is now a
    // deliberately unimplementable one. A plausible-sounding placeholder is a trap: it
    // turns "we added the route you asked for" into a red test in an unrelated file.
    expect(resolveRoutePath("not-a-route-and-never-will-be")).toBeNull();
    const r = buildProxyRequest({
      routeId: "not-a-route-and-never-will-be",
      payload: {},
      baseUrl: "http://h",
    });
    expect(r).toMatchObject({ url: null, reason: "unknown-route" });
    // NEGATIVE CONTROL — a real id resolves, so this is measuring the refusal and not a
    // resolver that returns null for everything.
    expect(resolveRoutePath("comment")).toBe(DEFAULT_ROUTES.comment);
  });
});

describe("⛔ the host sends NOTHING for identity (ADR-0031)", () => {
  test("the request body carries only the write — no host, node, hostname or actor key", () => {
    const req = buildProxyRequest({
      routeId: "issue-state",
      payload: { ticket: "CTL-1", transitionKey: "done" },
      baseUrl: "http://h/api/v1",
    });
    const body = JSON.parse(req.body);
    expect(Object.keys(body).sort()).toEqual(["ticket", "transitionKey"]);
    for (const forbidden of ["host", "hostname", "node", "nodeName", "actor", "actorId", "botUserId"]) {
      expect(body).not.toHaveProperty(forbidden);
    }
  });

  test("the curl config sends no host-identifying header", () => {
    const cfg = buildCurlConfig({ url: "http://h/x", method: "POST", token: TOKEN, body: "{}" });
    const headers = cfg.split("\n").filter((l) => l.startsWith("header = "));
    expect(headers.map((h) => h.toLowerCase()).join("\n")).not.toMatch(/host|node|actor/);
    // NEGATIVE CONTROL: the matcher CAN see a header when one is present.
    expect(headers.join("\n")).toMatch(/Authorization: Bearer/);
  });
});

describe("curl config — the credential never enters argv and never touches disk", () => {
  test("escaping is backslash-first then quote (order is load-bearing)", () => {
    expect(curlConfigEscape('a"b')).toBe('a\\"b');
    expect(curlConfigEscape("a\\nb")).toBe("a\\\\nb");
    expect(curlConfigEscape('x\\"y')).toBe('x\\\\\\"y');
  });

  test("defaultHttpFn's argv contains no fragment of the token", () => {
    // The seam returns the argv it used precisely so this can be asserted.
    const res = defaultHttpFn({ url: "http://127.0.0.1:1/x", method: "POST", token: TOKEN, body: "{}" });
    const argv = res.args.join(" ");
    expect(argv).not.toContain(TOKEN);
    expect(argv).not.toContain("Bearer");
    expect(res.args).toContain("--config");
    expect(res.args).toContain("-");
    // NEGATIVE CONTROL: the token IS in the document we hand to stdin, so the
    // assertion above is about placement, not about the token being absent everywhere.
    expect(buildCurlConfig({ url: "http://h/x", method: "POST", token: TOKEN, body: "{}" })).toContain(TOKEN);
  });
});

describe("classifyProxyResponse", () => {
  test.each([
    [{ code: 0, stdout: '{"outcome":"succeeded"}\n200' }, true, null, 200],
    // ⛔ A 2xx WITHOUT a parseable `outcome` is NOT applied. These routes always answer
    // with one, so a bodyless/HTML 2xx means we reached something other than the route
    // we think we did (a proxy, a redirect, an error page) — and "assume it worked" is
    // the one reading a write path may never take.
    [{ code: 0, stdout: "\n204" }, false, "unreadable-outcome", 204],
    [{ code: 0, stdout: '{"outcome":"rejected","reason":"Entity not found: Issue"}\n400' }, false, "cloud:rejected", 400],
    [{ code: 0, stdout: '{"outcome":"exhausted","lastError":"upstream"}\n502' }, false, "cloud:exhausted", 502],
    // A cloud outcome overrides the status class: the body is the verdict.
    [{ code: 0, stdout: '{"outcome":"failed","results":[]}\n400' }, false, "cloud:failed", 400],
    [{ code: 0, stdout: "no\n401" }, false, "unauthorized", 401],
    [{ code: 0, stdout: "no\n403" }, false, "unauthorized", 403],
    [{ code: 0, stdout: "no\n404" }, false, "not-found", 404],
    [{ code: 0, stdout: "no\n429" }, false, "rate-limited", 429],
    [{ code: 0, stdout: "no\n503" }, false, "server-error", 503],
    [{ code: 0, stdout: "no\n418" }, false, "rejected", 418],
    [{ code: 0, stdout: "garbage" }, false, "unreadable", null],
    [{ code: 7, stdout: "" }, false, "transport-error", null],
    [{ code: 127, stdout: "" }, false, "spawn-failed", null],
  ])("%p → applied=%p reason=%p", (raw, applied, reason, status) => {
    const v = classifyProxyResponse(raw);
    expect(v.applied).toBe(applied);
    expect(v.reason).toBe(reason);
    expect(v.status).toBe(status);
  });

  test("stderr is scrubbed on the transport-error path", () => {
    const v = classifyProxyResponse({ code: 7, stdout: "", stderr: "failed with Bearer ctok_secret" });
    expect(v.stderr).toBe("failed with Bearer ***");
  });
});

describe("scrub", () => {
  test.each([
    ["Bearer ctok_abc123", "Bearer ***"],
    ["wss://x/connect?token=abc123&a=1", "wss://x/connect?token=***&a=1"],
    ["lin_api_abc123", "lin_***"],
  ])("%p → %p", (a, b) => expect(scrub(a)).toBe(b));
});

describe("shadow — observes, and does NOT write", () => {
  test("returns handled:false so the caller performs its existing direct write", () => {
    const http = recorder();
    const emit = eventSink();
    const p = createLinearWriteProxy({ mode: "shadow", env: envWithKey(), httpFn: http, appendEvent: emit, log: silentLog });
    const r = p.send({ routeId: "label", ticket: "CTL-1", payload: { labels: ["needs-human"] } });
    expect(r).toEqual({ handled: false, applied: false, reason: "shadow" });
  });

  test("⛔ makes NO cloud call — 'observe by doing it too' would double-write the board", () => {
    const http = recorder();
    const p = createLinearWriteProxy({ mode: "shadow", env: envWithKey(), httpFn: http, appendEvent: eventSink(), log: silentLog });
    p.send({ routeId: "label", ticket: "CTL-1", payload: {} });
    expect(http.calls).toHaveLength(0);
    // NEGATIVE CONTROL: the same recorder DOES record under enforce, so the zero
    // above is a decision, not a dead seam.
    const q = createLinearWriteProxy({ mode: "enforce", env: envWithKey(), httpFn: http, appendEvent: eventSink(), log: silentLog });
    q.send({ routeId: "label", ticket: "CTL-1", payload: {} });
    expect(http.calls).toHaveLength(1);
  });

  test("emits would-write under its OWN event name, never the applied name", () => {
    const emit = eventSink();
    const p = createLinearWriteProxy({ mode: "shadow", env: envWithKey(), httpFn: recorder(), appendEvent: emit, log: silentLog });
    p.send({ routeId: "issue-state", ticket: "CTL-7", payload: {} });
    expect(emit.names()).toEqual([`${EVENT_WOULD_WRITE}.CTL-7`]);
    const e = emit.events()[0];
    expect(e.attributes["catalyst.linear_write_proxy.mode"]).toBe("shadow");
    expect(e.attributes["catalyst.linear_write_proxy.route"]).toBe("issue-state");
    expect(e.body.payload.applied).toBe(false);
  });

  test("shadow needs no cloud key — an unprovisioned host can still run the window", () => {
    const emit = eventSink();
    const p = createLinearWriteProxy({ mode: "shadow", env: {}, httpFn: recorder(), appendEvent: emit, log: silentLog });
    expect(p.send({ routeId: "label", ticket: "CTL-1", payload: {} }).handled).toBe(false);
    expect(emit.names()).toEqual([`${EVENT_WOULD_WRITE}.CTL-1`]);
  });
});

describe("enforce — the proxy IS the write", () => {
  test("a 2xx is applied, and the request went to base+route", () => {
    const http = recorder({ code: 0, stdout: '{"outcome":"succeeded"}\n200' });
    const emit = eventSink();
    const p = createLinearWriteProxy({
      mode: "enforce",
      env: envWithKey({ CATALYST_CLOUD_BASE_URL: "http://cloud/api/v1" }),
      httpFn: http,
      appendEvent: emit,
      log: silentLog,
    });
    const r = p.send({ routeId: "label", ticket: "CTL-2", payload: { labels: ["a"] } });
    expect(r).toEqual({ handled: true, applied: true, reason: null, status: 200 });
    expect(http.calls[0].url).toBe("http://cloud/api/v1/agent/issue-label");
    expect(http.calls[0].token).toBe(TOKEN);
    expect(emit.names()).toEqual([`${EVENT_APPLIED}.CTL-2`]);
    expect(p.counts()).toMatchObject({ applied: 1, failed: 0, wouldWrite: 0 });
    // NEGATIVE CONTROL for the two tests below: a real success with no `results`
    // array at all carries no `converged` key — the flag's absence here is a
    // decision (nothing to derive convergence from), not a broken wire.
    expect(r).not.toHaveProperty("converged");
  });

  // CTL-2098: the real HTTP body → classifyProxyResponse → send() chain, proving
  // `converged` reaches the caller from an ACTUAL response shape (CTC-674's
  // already-absent outcome), not merely a hand-built stub. This is the transport
  // layer the review's "root-cause premise unverified" finding named directly
  // (linear-write-proxy.mjs — the file the finding cited by line number).
  test("⭐ CTL-2098: an already-absent label removal reports converged:true, additively", () => {
    const body = JSON.stringify({ outcome: "succeeded", results: [{ outcome: "already-absent" }] });
    const http = recorder({ code: 0, stdout: `${body}
200` });
    const p = createLinearWriteProxy({ mode: "enforce", env: envWithKey(), httpFn: http, appendEvent: eventSink(), log: silentLog });
    const r = p.send({ routeId: "label", ticket: "CTL-2098-live", payload: { labelIds: ["x"], mode: "remove" } });
    expect(r).toEqual({ handled: true, applied: true, reason: null, status: 200, converged: true });
  });

  test("a MIXED results batch (one already-absent, one real removal) is NOT converged", () => {
    // Boundary the production code actually draws: `.every()`, not `.some()`. A
    // batch that did SOME real work must disarm markers normally — calling that
    // convergence would silently mask a real change from the daemon's dedup
    // consumer, which is the "changes wrote's semantics for every caller" risk
    // Ryan's decision explicitly ruled out.
    const body = JSON.stringify({
      outcome: "succeeded",
      results: [{ outcome: "already-absent" }, { outcome: "removed" }],
    });
    const http = recorder({ code: 0, stdout: `${body}
200` });
    const p = createLinearWriteProxy({ mode: "enforce", env: envWithKey(), httpFn: http, appendEvent: eventSink(), log: silentLog });
    const r = p.send({ routeId: "label", ticket: "CTL-2098-mixed", payload: { labelIds: ["x", "y"], mode: "remove" } });
    expect(r).toEqual({ handled: true, applied: true, reason: null, status: 200 });
    expect(r).not.toHaveProperty("converged");
  });

  test("⭐ THE LOUD NO-CREDENTIAL REFUSAL: no per-host key → named reason, no HTTP, no silent degrade", () => {
    const http = recorder();
    const emit = eventSink();
    const errors = [];
    const p = createLinearWriteProxy({
      mode: "enforce",
      env: {}, // no cloud token anywhere
      httpFn: http,
      appendEvent: emit,
      log: { ...silentLog, error: (o, m) => errors.push({ o, m }) },
    });
    const r = p.send({ routeId: "issue-state", ticket: "CTL-3", payload: {} });
    // handled:true is the point — the caller must NOT fall back to a direct write.
    expect(r).toEqual({ handled: true, applied: false, reason: "no-cloud-token" });
    expect(http.calls).toHaveLength(0);
    expect(emit.names()).toEqual([`${EVENT_FAILED}.CTL-3`]);
    expect(emit.events()[0].severityText).toBe("ERROR");
    expect(emit.events()[0].attributes["catalyst.linear_write_proxy.reason"]).toBe("no-cloud-token");
    // LOUD: an ERROR line naming the reason and the env var it looked in.
    expect(errors).toHaveLength(1);
    expect(errors[0].m).toContain("no-cloud-token");
    expect(errors[0].o.token_env).toBe("CATALYST_CLOUD_TOKEN");
  });

  test.each([
    ["\n401", "unauthorized"],
    ["\n404", "not-found"],
    ["\n429", "rate-limited"],
    ["\n500", "server-error"],
  ])("a %p response is a NAMED failure (%p), never a silent success", (tail, reason) => {
    const emit = eventSink();
    const p = createLinearWriteProxy({
      mode: "enforce",
      env: envWithKey(),
      httpFn: recorder({ code: 0, stdout: `body${tail}` }),
      appendEvent: emit,
      log: silentLog,
    });
    const r = p.send({ routeId: "comment", ticket: "CTL-4", payload: { body: "hi" } });
    expect(r).toEqual({ handled: true, applied: false, reason });
    expect(emit.names()).toEqual([`${EVENT_FAILED}.CTL-4`]);
  });

  test("a throwing transport is a named failure, NOT a fall-back to the direct path", () => {
    const p = createLinearWriteProxy({
      mode: "enforce",
      env: envWithKey(),
      httpFn: () => {
        throw new Error("boom Bearer ctok_leak");
      },
      appendEvent: eventSink(),
      log: silentLog,
    });
    expect(p.send({ routeId: "label", ticket: "CTL-5", payload: {} })).toEqual({
      handled: true,
      applied: false,
      reason: "spawn-failed",
    });
  });

  test("a body over the cap is REFUSED, never truncated and never sent", () => {
    const http = recorder();
    const p = createLinearWriteProxy({ mode: "enforce", env: envWithKey(), httpFn: http, appendEvent: eventSink(), log: silentLog });
    const r = p.send({ routeId: "comment", ticket: "CTL-6", payload: { body: "x".repeat(MAX_BODY_BYTES + 1) } });
    expect(r).toEqual({ handled: true, applied: false, reason: "body-too-large" });
    expect(http.calls).toHaveLength(0);
    // NEGATIVE CONTROL: a body just under the cap DOES go out, so the refusal is a
    // threshold and not a route that never sends anything.
    const ok = p.send({ routeId: "comment", ticket: "CTL-6", payload: { body: "x".repeat(1000) } });
    expect(ok.reason).not.toBe("body-too-large");
    expect(http.calls).toHaveLength(1);
  });

  test("an unusable route id refuses before resolving the key", () => {
    const http = recorder();
    const p = createLinearWriteProxy({ mode: "enforce", env: {}, httpFn: http, appendEvent: eventSink(), log: silentLog });
    expect(p.send({ routeId: "not-a-route-and-never-will-be", ticket: "CTL-8", payload: {} })).toEqual({
      handled: true,
      applied: false,
      reason: "unknown-route",
    });
    expect(http.calls).toHaveLength(0);
  });

  test("a failing event sink never blocks or flips the write decision", () => {
    const p = createLinearWriteProxy({
      mode: "enforce",
      env: envWithKey(),
      httpFn: recorder({ code: 0, stdout: '{"outcome":"succeeded"}\n200' }),
      appendEvent: () => {
        throw new Error("disk full");
      },
      log: silentLog,
    });
    expect(p.send({ routeId: "label", ticket: "CTL-9", payload: {} }).applied).toBe(true);
  });
});

describe("event names", () => {
  test("the names are distinct and shadow's is not the applied one", () => {
    // CTL-1936 added a fourth: the budget-exhausted alarm. The assertion is on
    // DISTINCTNESS and the shared prefix (which the broker's namespace contract keys
    // on), not on a hard-coded count — a count makes every new event a test failure
    // without saying anything about correctness.
    expect(new Set(PROXY_EVENT_NAMES).size).toBe(PROXY_EVENT_NAMES.length);
    expect(PROXY_EVENT_NAMES.length).toBeGreaterThanOrEqual(4);
    expect(EVENT_WOULD_WRITE).not.toBe(EVENT_APPLIED);
    expect(PROXY_EVENT_NAMES.every((n) => n.startsWith("linear.write.proxy."))).toBe(true);
  });
});

// ─── POSITIVE CONTROL: a real curl against a real out-of-process server ──────
//
// Everything above stubs the transport, so none of it can prove the curl config
// document is actually well-formed — an escaping bug would pass every test above and
// fail only in production. This block runs the REAL defaultHttpFn against a live HTTP
// server and asserts the bytes that arrived.
//
// ⛔ The server MUST be a separate OS process. defaultHttpFn is a blocking spawnSync,
// so a Bun.serve in this process could never answer it (its handler is JS on the
// blocked thread) — the first cut of this test timed out for exactly that reason,
// which would have read as "the transport is broken" rather than "the harness is".
describe("defaultHttpFn round-trip against a real server", () => {
  let proc = null;
  let recordFile = null;
  let tmp = null;

  /** Start the fixture server, resolving once it has printed its port. */
  async function startServer(status = 200) {
    tmp = mkdtempSync(join(tmpdir(), "ctl1889-"));
    recordFile = join(tmp, "requests.jsonl");
    writeFileSync(recordFile, "");
    proc = Bun.spawn(
      [process.execPath, join(import.meta.dir, "__fixtures__", "http-echo-server.mjs"), recordFile, String(status)],
      { stdout: "pipe", stderr: "inherit" },
    );
    const reader = proc.stdout.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (!buf.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) throw new Error("fixture server exited before reporting a port");
      buf += dec.decode(value, { stream: true });
    }
    reader.releaseLock();
    const m = /PORT (\d+)/.exec(buf);
    if (!m) throw new Error(`fixture server printed no port: ${buf}`);
    return Number(m[1]);
  }

  const requests = () =>
    readFileSync(recordFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));

  afterEach(() => {
    try { proc?.kill(); } catch { /* already gone */ }
    proc = null;
    try { if (tmp) rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
    tmp = null;
  });

  // ⛔ THE CHILD'S DEADLINE, PROVEN TO FIRE (Codex #3489 round 2, P1). A watchdog that is
  // merely PRESENT in the source is the shape of guardrail this repo has shipped broken
  // before, so this asserts the behaviour: a server that boots, serves, and then ends
  // itself while the parent does nothing at all.
  test("⭐ the fixture server self-terminates on its own deadline, with NO kill from the parent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ctl1889-deadline-"));
    const rec = join(dir, "requests.jsonl");
    writeFileSync(rec, "");
    // ⚠️ Deliberately NOT assigned to the suite's `proc`, so `afterEach` cannot reach it.
    // The ONLY thing able to end this process is its own timer — which is precisely the
    // property under test, and it would be untestable if cleanup could do it instead.
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, "__fixtures__", "http-echo-server.mjs"), rec, "200", "700"],
      { stdout: "pipe", stderr: "ignore" },
    );
    // Positive control: read the readiness line first, so a process that died at startup
    // (a typo in the fixture, a missing arg) cannot be mistaken for one that timed out.
    const reader = child.stdout.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (!buf.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`fixture exited before listening: ${buf}`);
      buf += dec.decode(value, { stream: true });
    }
    reader.releaseLock();
    expect(/PORT \d+/.test(buf)).toBe(true);

    const started = Date.now();
    const code = await child.exited;
    const elapsed = Date.now() - started;
    expect(code).toBe(0);
    // It waited for the deadline rather than falling over, and it needed nobody's help.
    expect(elapsed).toBeGreaterThanOrEqual(300);
    expect(elapsed).toBeLessThan(20_000);
    rmSync(dir, { recursive: true, force: true });
  }, 30_000);

  test("curl is present at the absolute path the transport uses", () => {
    // Not a skip: curl IS a dependency of this transport, so its absence is a failure
    // of the environment the feature would run in, and must be loud.
    expect(existsSync(CURL_BIN)).toBe(true);
  });

  test("⭐ a body with quotes, backslashes, newlines, commas and unicode arrives BYTE-IDENTICAL", async () => {
    // Every character class curl's config parser un-escapes, plus a comma-bearing
    // label name (the collision linear-write-echo's normalizeEchoValue warns about).
    const port = await startServer(200);
    const payload = {
      ticket: "CTL-1889",
      body: 'he said "hi"\nline2\tTAB\\slash\r\nend — ünïcode 🚀',
      labels: ["needs,human", 'quo"te', "back\\slash"],
    };
    const req = buildProxyRequest({ routeId: "comment", payload, baseUrl: `http://127.0.0.1:${port}/api/v1` });
    const res = defaultHttpFn({ url: req.url, method: req.method, token: TOKEN, body: req.body });

    expect(classifyProxyResponse(res)).toMatchObject({ applied: true, status: 200 });
    const got = requests();
    expect(got).toHaveLength(1);
    expect(got[0].method).toBe("POST");
    expect(got[0].path).toBe("/api/v1/agent/issue-comment");
    expect(got[0].auth).toBe(`Bearer ${TOKEN}`);
    expect(got[0].contentType).toBe("application/json");
    // The load-bearing assertion: the JSON survived curl's config quoting exactly.
    expect(got[0].body).toBe(req.body);
    expect(JSON.parse(got[0].body)).toEqual(payload);
  });

  test("no host-identifying header reaches the server", async () => {
    const port = await startServer(200);
    const req = buildProxyRequest({
      routeId: "label",
      payload: { ticket: "CTL-1", labels: [] },
      baseUrl: `http://127.0.0.1:${port}/api/v1`,
    });
    defaultHttpFn({ url: req.url, method: req.method, token: TOKEN, body: req.body });
    const names = requests()[0].headerNames.map((n) => n.toLowerCase());
    // `host` is HTTP/1.1's mandatory authority header (127.0.0.1:<port>), not an
    // identity claim — every other host-shaped name must be absent.
    expect(names.filter((n) => n !== "host" && /host|node|actor|catalyst/.test(n))).toEqual([]);
    // NEGATIVE CONTROL: the filter CAN see a name when one matches.
    expect(["x-catalyst-host"].filter((n) => /host|node|actor|catalyst/.test(n))).toEqual(["x-catalyst-host"]);
  });

  test("a non-2xx from a real server classifies as a named failure end to end", async () => {
    const port = await startServer(401);
    const req = buildProxyRequest({ routeId: "label", payload: {}, baseUrl: `http://127.0.0.1:${port}/api/v1` });
    const res = defaultHttpFn({ url: req.url, method: req.method, token: TOKEN, body: req.body });
    expect(classifyProxyResponse(res)).toMatchObject({ applied: false, reason: "unauthorized", status: 401 });
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════
// CTL-1889 increment 3 / CTC-692 — the attachment write route and the GET read-back.
// ══════════════════════════════════════════════════════════════════════════════════════

describe("the attachment pair (CTL-1889 inc 3)", () => {
  test("`attachment` is a WRITE route and is NOT async-eligible — the claim is dispatch-critical", () => {
    expect(PROXY_ROUTE_IDS).toContain("attachment");
    // ⛔ The asymmetry that matters: a lost narration costs an observation, a lost claim
    // costs the mutex. If someone adds "attachment" to the non-blocking set to make dispatch
    // feel faster, this fails.
    expect(NON_BLOCKING_ROUTE_IDS.has("attachment")).toBe(false);
    expect(resolveRoutePath("attachment")).toBe("/agent/attachment");
  });

  test("`attachments` is a READ route and is NOT in the write route ids", () => {
    expect(READ_ROUTE_IDS.has("attachments")).toBe(true);
    // A read must never be reachable through `send`, which would spend a write-budget unit
    // on it and let an exhausted host stop being able to VERIFY a claim.
    expect(PROXY_ROUTE_IDS).not.toContain("attachments");
    expect(resolveRoutePath("attachments")).toBe("/agent/attachments");
  });

  test("the read route builds a GET with issueId in the query string and NO body", () => {
    const req = buildProxyRequest({
      routeId: "attachments",
      baseUrl: "https://c/api/v1",
      query: { issueId: "CTL-1889" },
      account: "acct-1",
    });
    expect(req.method).toBe("GET");
    expect(req.body).toBeNull();
    expect(req.url).toBe("https://c/api/v1/agent/attachments?issueId=CTL-1889&account=acct-1");
  });

  test("⛔ the GET's curl config emits NO `data` line — a body would make curl send a POST", () => {
    const cfg = buildCurlConfig({ url: "https://c/x", method: "GET", token: TOKEN, body: null });
    // Asserting the ABSENCE, positively: curl treats any request carrying a body as a POST
    // regardless of `request = "GET"`, so a stray `data = ""` would 404 on a live route.
    expect(cfg).not.toContain("data =");
    expect(cfg).toContain('request = "GET"');
    // NEGATIVE CONTROL — the same builder DOES emit `data` for a write, so the assertion
    // above is measuring the branch and not a broken matcher.
    expect(buildCurlConfig({ url: "https://c/x", method: "POST", token: TOKEN, body: "{}" })).toContain(
      'data = "{}"',
    );
  });

  test("the write route still POSTs a body, unchanged", () => {
    const req = buildProxyRequest({
      routeId: "attachment",
      payload: { issueId: "CTL-1", url: "catalyst://fence/CTL-1" },
      baseUrl: "https://c/api/v1",
    });
    expect(req.method).toBe("POST");
    expect(JSON.parse(req.body).issueId).toBe("CTL-1");
  });

  test("read() returns the attachments on a succeeded body", () => {
    const rec = recorder({
      code: 0,
      stdout: JSON.stringify({ outcome: "succeeded", attachments: [{ id: "a", url: "u" }] }) + "\n200",
      stderr: "",
    });
    const p = createLinearWriteProxy({ mode: "enforce", env: envWithKey(), httpFn: rec });
    const res = p.read({ routeId: "attachments", ticket: "CTL-1", query: { issueId: "CTL-1" } });
    expect(res.ok).toBe(true);
    expect(res.attachments).toEqual([{ id: "a", url: "u" }]);
    expect(rec.calls[0].method).toBe("GET");
  });

  test("⛔ read() NEVER fabricates an empty list — a 200 with an unreadable body is ok:false", () => {
    // The specific way a read can lie: HTTP 200, but the body is not the answer we asked for
    // (a proxy error page, a truncated write, a route that moved). Reporting `[]` here would
    // tell the soft-CAS that nobody holds the ticket.
    for (const stdout of ["<html>oops</html>\n200", '{"outcome":"succeeded"}\n200', "\n200"]) {
      const p = createLinearWriteProxy({
        mode: "enforce",
        env: envWithKey(),
        httpFn: recorder({ code: 0, stdout, stderr: "" }),
      });
      const res = p.read({ routeId: "attachments", query: { issueId: "CTL-1" } });
      expect(res.ok).toBe(false);
      expect(res.attachments).toBeUndefined();
    }
  });

  test("read() refuses a non-read route BY NAME rather than quietly performing a write", () => {
    const p = createLinearWriteProxy({ mode: "enforce", env: envWithKey(), httpFn: recorder() });
    expect(p.read({ routeId: "comment", query: {} })).toMatchObject({
      ok: false,
      reason: "route-not-read-eligible",
    });
  });

  test("read() with no per-host key refuses LOUDLY — the negative control, same as the writes", () => {
    const p = createLinearWriteProxy({ mode: "enforce", env: {}, httpFn: recorder() });
    expect(p.read({ routeId: "attachments", query: { issueId: "X" } })).toMatchObject({
      ok: false,
      reason: "no-cloud-token",
    });
  });

  test("⛔ read() spends NO write budget — an exhausted host must still be able to VERIFY a claim", () => {
    const dir = mkdtempSync(join(tmpdir(), "wp-read-budget-"));
    const ledgerPath = join(dir, "budget.json");
    try {
      const rec = recorder({
        code: 0,
        stdout: JSON.stringify({ outcome: "succeeded", attachments: [] }) + "\n200",
        stderr: "",
      });
      const p = createLinearWriteProxy({
        mode: "enforce",
        env: envWithKey(),
        httpFn: rec,
        budgetPath: ledgerPath,
      });
      for (let i = 0; i < 5; i++) p.read({ routeId: "attachments", ticket: "CTL-1", query: { issueId: "CTL-1" } });
      // Five reads, and the ledger was never even created — reads do not touch it.
      expect(existsSync(ledgerPath)).toBe(false);

      // NEGATIVE CONTROL — one WRITE through the same proxy does create and spend it, so the
      // assertion above is about reads and not about a ledger that never works.
      p.send({ routeId: "attachment", ticket: "CTL-1", payload: { issueId: "CTL-1" } });
      expect(JSON.parse(readFileSync(ledgerPath, "utf8")).total).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("SHADOW still performs the read — a read has no double-apply hazard, and a shadow window that cannot read proves nothing", () => {
    const rec = recorder({
      code: 0,
      stdout: JSON.stringify({ outcome: "succeeded", attachments: [] }) + "\n200",
      stderr: "",
    });
    const p = createLinearWriteProxy({ mode: "shadow", env: envWithKey(), httpFn: rec });
    expect(p.read({ routeId: "attachments", query: { issueId: "CTL-1" } }).ok).toBe(true);
    expect(rec.calls).toHaveLength(1);
    // NEGATIVE CONTROL — the same proxy in shadow makes NO call for a write.
    p.send({ routeId: "attachment", ticket: "CTL-1", payload: {} });
    expect(rec.calls).toHaveLength(1);
  });
});
