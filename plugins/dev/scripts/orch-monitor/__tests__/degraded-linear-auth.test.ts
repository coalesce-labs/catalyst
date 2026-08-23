// CTL-2187 — the orch-monitor resolves a Linear credential for its DEGRADED reads.
//
// The bug: catalyst-monitor.sh cmd_start deliberately clears LINEAR_API_TOKEN /
// LINEAR_API_KEY (CTL-1612) and mints a SCOPED credential into
// CATALYST_MONITOR_APP_ACTOR_TOKEN. The degraded resolvers resolved only the two
// cleared aliases, so every read returned before `fetch` and emitted
// `catalyst.linear.read result=failed` — ~788k WARN records in 8 days, constant
// rather than decaying because getEstimationMethodAsync never resolved and
// therefore never wrote the team-estimation cache.
//
// ⛔ WHAT THESE TESTS ASSERT, AND WHAT THEY DELIBERATELY DO NOT
// "the warning stopped" is the NEIGHBOUR of the property, not the property —
// deleting the emitter would achieve it. The property asserted here is:
//   (1) a request is actually DISPATCHED, with the scoped credential, and
//   (2) the team-estimation cache is actually WRITTEN to disk,
// which is the thing whose absence made the rate constant. The emission counts
// below are read as CORROBORATION of (1)/(2), never as the success criterion.
//
// ⛔ THE CTL-1612 CONTROL
// "no leak into the inline-reply path" is a planted negative control, not a
// comment: the scoped token must never become resolvable by linear-comment.mjs's
// linearTokenCandidates / resolveLinearToken, which is what would make an
// operator's inline reply post as the app actor. Writing the token onto
// process.env.LINEAR_API_TOKEN inside resolveDegradedLinearAuth turns that suite
// RED — verified by planting exactly that break.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  resolveDegradedLinearAuth,
  SCOPED_APP_ACTOR_ENV,
  TIER_ENV_ALIAS,
  TIER_SCOPED_APP_ACTOR,
} from "../lib/linear-degraded-auth.mjs";
import {
  getEstimationMethodAsync,
  fillEstimateFallback,
  _clearEstimateCache,
  _clearMethodCache,
} from "../lib/linear-estimate-fallback.mjs";
import { linearTokenCandidates, resolveLinearToken } from "../lib/linear-comment.mjs";
import { teamEstimationCachePath } from "../../execution-core/linear-estimation-method.mjs";

const SCOPED_TOKEN = "lin_oauth_ctl2187_scoped";

// ── Sandbox ──────────────────────────────────────────────────────────────────
// HOME drives the team-estimation cache path (linear-estimation-method.mjs
// cacheDir); CATALYST_DIR drives the event log (linear-read-event.mjs
// eventLogPath). Both are re-pointed per test so the disk assertions below read
// THIS test's writes and nothing else.
let sandbox: string;
let savedHome: string | undefined;
let savedCatalystDir: string | undefined;
let savedFetch: typeof globalThis.fetch;

function eventLogPath(): string {
  const now = new Date();
  const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  return join(process.env.CATALYST_DIR as string, "events", `${ym}.jsonl`);
}

interface EventRecord {
  attributes?: Record<string, string>;
}

/** Every `catalyst.linear.read` record this test's resolvers appended. */
function readLinearReadEvents(): Array<Record<string, string>> {
  const path = eventLogPath();
  if (!existsSync(path)) return [];
  const records = readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l): EventRecord => JSON.parse(l) as EventRecord);
  return records
    .filter((r) => r.attributes?.["event.name"] === "catalyst.linear.read")
    .map((r) => r.attributes ?? {});
}

/** Mock fetch: records Authorization headers, replies with a canned body. */
function mockFetch(body: unknown, { ok = true }: { ok?: boolean } = {}) {
  const auths: Array<string | null> = [];
  globalThis.fetch = ((_url: unknown, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    auths.push(headers.Authorization ?? null);
    return Promise.resolve({ ok, json: () => Promise.resolve(body) } as Response);
  }) as typeof fetch;
  return auths;
}

const TEAM_METHOD_BODY = {
  data: { teams: { nodes: [{ issueEstimation: { type: "tShirt", allowZero: false, extended: true } }] } },
};

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "ctl2187-"));
  savedHome = process.env.HOME;
  savedCatalystDir = process.env.CATALYST_DIR;
  savedFetch = globalThis.fetch;
  process.env.HOME = join(sandbox, "home");
  process.env.CATALYST_DIR = join(sandbox, "catalyst");
  delete process.env.LINEAR_API_TOKEN;
  delete process.env.LINEAR_API_KEY;
  delete process.env[SCOPED_APP_ACTOR_ENV];
  _clearEstimateCache();
  _clearMethodCache();
});

afterEach(() => {
  globalThis.fetch = savedFetch;
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedCatalystDir === undefined) delete process.env.CATALYST_DIR;
  else process.env.CATALYST_DIR = savedCatalystDir;
  delete process.env.LINEAR_API_TOKEN;
  delete process.env.LINEAR_API_KEY;
  delete process.env[SCOPED_APP_ACTOR_ENV];
  _clearEstimateCache();
  _clearMethodCache();
  rmSync(sandbox, { recursive: true, force: true });
});

// ── The tier ladder ──────────────────────────────────────────────────────────

describe("CTL-2187: resolveDegradedLinearAuth tier ladder", () => {
  it("resolves the SCOPED app-actor mint when both env aliases are cleared (the monitor's real posture)", () => {
    const env = { [SCOPED_APP_ACTOR_ENV]: SCOPED_TOKEN };
    const auth = resolveDegradedLinearAuth({ env });
    expect(auth).not.toBeNull();
    expect(auth?.tier).toBe(TIER_SCOPED_APP_ACTOR);
    // OAuth access token → Bearer, matching linear-query.mjs authHeader.
    expect(auth?.header).toBe(`Bearer ${SCOPED_TOKEN}`);
  });

  it("keeps the operator's personal key AHEAD of the scoped mint (a lin_api_* key survives the CTL-1612 clear)", () => {
    const env = { LINEAR_API_TOKEN: "lin_api_operator", [SCOPED_APP_ACTOR_ENV]: SCOPED_TOKEN };
    const auth = resolveDegradedLinearAuth({ env });
    expect(auth?.tier).toBe(TIER_ENV_ALIAS);
    expect(auth?.header).toBe("lin_api_operator"); // personal key sent raw, not Bearer
  });

  it("returns null — honestly — when NO tier resolves", () => {
    expect(resolveDegradedLinearAuth({ env: {} })).toBeNull();
    // Whitespace is not a credential.
    expect(resolveDegradedLinearAuth({ env: { [SCOPED_APP_ACTOR_ENV]: "   " } })).toBeNull();
  });
});

// ── The property: the read is DISPATCHED and the cache is WRITTEN ────────────

describe("CTL-2187: the degraded team-method read dispatches and caches", () => {
  it("dispatches with the scoped credential and WRITES the team-estimation cache", async () => {
    process.env[SCOPED_APP_ACTOR_ENV] = SCOPED_TOKEN;
    const auths = mockFetch(TEAM_METHOD_BODY);

    const method = await getEstimationMethodAsync("CTL");

    // (1) a request was actually dispatched, carrying the scoped credential.
    expect(auths).toEqual([`Bearer ${SCOPED_TOKEN}`]);
    expect(method).toEqual({ type: "tShirt", allowZero: false, extended: true });

    // (2) THE PROPERTY: the estimation cache is on disk. Its absence is what
    // made every board render re-attempt — a resolved method that is not
    // persisted would leave the rate exactly where it was.
    const cachePath = teamEstimationCachePath("CTL");
    expect(existsSync(cachePath)).toBe(true);
    expect(JSON.parse(readFileSync(cachePath, "utf8")).method.type).toBe("tShirt");

    // Corroboration only: the emitted read says ok, not failed.
    const events = readLinearReadEvents();
    expect(events.length).toBe(1);
    expect(events[0]["linear.read.op"]).toBe("team_method");
    expect(events[0]["linear.read.result"]).toBe("ok");
  });

  it("does NOT re-read once cached — a second render is served from disk", async () => {
    process.env[SCOPED_APP_ACTOR_ENV] = SCOPED_TOKEN;
    const auths = mockFetch(TEAM_METHOD_BODY);

    await getEstimationMethodAsync("CTL");
    _clearMethodCache(); // drop the in-process memo; the DISK record must carry it
    const second = await getEstimationMethodAsync("CTL");

    expect(second).toEqual({ type: "tShirt", allowZero: false, extended: true });
    expect(auths.length).toBe(1); // one dispatch total, not one per render
    expect(readLinearReadEvents().length).toBe(1);
  });

  it("carries the scoped credential into the ESTIMATE read too", async () => {
    process.env[SCOPED_APP_ACTOR_ENV] = SCOPED_TOKEN;
    const auths = mockFetch({
      data: { issues: { nodes: [{ number: 2187, estimate: 3, team: { key: "CTL" } }] } },
    });

    const result = await fillEstimateFallback(["CTL-2187"], {
      // Pin the replica gate CLOSED so this exercises the DEGRADED tier on a dev
      // box (which has a real replica) exactly as it does in CI (which does not).
      replicaOptions: { dbPath: join(sandbox, "absent-replica.db") },
    });

    expect(auths).toEqual([`Bearer ${SCOPED_TOKEN}`]);
    expect(result["CTL-2187"]).toBe(3);
  });
});

// ── NEGATIVE CONTROL 1: the credential-absent path ──────────────────────────
//
// This suite is the planted control for the credential half. Remove the scoped
// tier from resolveDegradedLinearAuth (or stop setting the var) and the
// "dispatches … and WRITES" case above goes red; this suite pins the OTHER side
// of the same boundary — that a genuinely credential-less host still says so and
// writes nothing, so a future "fix" cannot satisfy the first suite by faking a
// credential or a cache write.

describe("CTL-2187 negative control: no credential of any tier", () => {
  it("dispatches nothing, caches nothing, and reports result=failed", async () => {
    const auths = mockFetch(TEAM_METHOD_BODY);

    const method = await getEstimationMethodAsync("CTL");

    expect(method).toBeNull();
    expect(auths.length).toBe(0); // no HTTP request is made at all
    expect(existsSync(teamEstimationCachePath("CTL"))).toBe(false);

    const events = readLinearReadEvents();
    expect(events.length).toBe(1);
    expect(events[0]["linear.read.result"]).toBe("failed");
  });

  it("bounds the failed re-attempt instead of firing once per render", async () => {
    mockFetch(TEAM_METHOD_BODY);

    await getEstimationMethodAsync("CTL");
    await getEstimationMethodAsync("CTL");
    await getEstimationMethodAsync("CTL");

    // Three renders, ONE warning — the ticket's third scenario. The emitter is
    // untouched; what stops repeating is the READ ATTEMPT.
    const failed = readLinearReadEvents().filter((e) => e["linear.read.result"] === "failed");
    expect(failed.length).toBe(1);
  });
});

// ── NEGATIVE CONTROL 2: CTL-1612 — no leak into the inline-reply path ───────
//
// The whole reason this fix threads the SCOPED variable rather than restoring
// the cleared aliases. linear-comment.mjs's linearTokenCandidates resolves
// env.LINEAR_API_TOKEN / env.LINEAR_API_KEY FIRST, ahead of the Layer-2 personal
// token — so any app-actor value reachable under either alias is the value an
// operator's inline reply would be posted with.

describe("CTL-2187 negative control: the scoped token never reaches the inline-reply path", () => {
  it("leaves process.env.LINEAR_API_TOKEN / LINEAR_API_KEY untouched across a full degraded read", async () => {
    process.env[SCOPED_APP_ACTOR_ENV] = SCOPED_TOKEN;
    mockFetch(TEAM_METHOD_BODY);

    await getEstimationMethodAsync("CTL");
    await fillEstimateFallback(["CTL-2187"], {
      replicaOptions: { dbPath: join(sandbox, "absent-replica.db") },
    });

    expect(process.env.LINEAR_API_TOKEN).toBeUndefined();
    expect(process.env.LINEAR_API_KEY).toBeUndefined();
  });

  it("is invisible to linearTokenCandidates / resolveLinearToken — the definitive reply-credential list", async () => {
    process.env[SCOPED_APP_ACTOR_ENV] = SCOPED_TOKEN;
    mockFetch(TEAM_METHOD_BODY);
    await getEstimationMethodAsync("CTL");

    const projectConfig = { linear: { apiToken: "lin_api_the_operators_own_key" } };
    const candidates = linearTokenCandidates(process.env, { projectConfig });

    expect(candidates).not.toContain(SCOPED_TOKEN);
    expect(candidates).not.toContain(`Bearer ${SCOPED_TOKEN}`);
    // The operator's own Layer-2 key is still the one a reply would use.
    expect(resolveLinearToken(process.env, { projectConfig })).toBe("lin_api_the_operators_own_key");
  });

  it("does not mutate the env object it is handed", () => {
    const env: Record<string, string | undefined> = { [SCOPED_APP_ACTOR_ENV]: SCOPED_TOKEN };
    resolveDegradedLinearAuth({ env });
    expect(Object.keys(env)).toEqual([SCOPED_APP_ACTOR_ENV]);
  });
});
