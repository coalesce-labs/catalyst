// github-auth-preflight.test.mjs — CTL-1612. FULLY OFFLINE: every test injects
// `probe` / `emitAlert` / `log` and an EXPLICIT `env` object, so no test ever
// reads process.env, spawns `gh`, appends to the event log, or touches the
// network. The one test that exercises the real `defaultProbeGithubAuth` points
// its injected PATH at an EMPTY temp dir, so `gh` cannot resolve and the probe
// classifies locally (never a request). Inherits test-setup.mjs.
//
// The contract under test is the ANTI-PAGING one: a definitive 401 alerts EXACTLY
// once; every other outcome — spawn failure, non-401 exit, timeout, a throwing
// probe, a malformed result — stays SILENT, because "could not prove the
// credential is good" is not "the credential is bad".
//
// NO REAL SECRET VALUE APPEARS ANYWHERE IN THIS FILE. The token-shaped literals
// below are obvious fakes used only to prove they are never surfaced.
//
// Run: cd plugins/dev/scripts/execution-core && bun test github-auth-preflight.test.mjs

import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GITHUB_PROBE_TIMEOUT_MS,
  defaultProbeGithubAuth,
  isUnauthorizedOutput,
  resolveGithubBootAuth,
} from "./github-auth-preflight.mjs";

// ── Fakes ─────────────────────────────────────────────────────────────────────

// An obviously-fake credential literal. It exists ONLY so the hygiene test can
// prove no code path ever echoes a credential value into a log or an alert.
const FAKE_TOKEN = "ghp_THIS-IS-NOT-A-REAL-TOKEN-000000000000";

// The three-state probe results, spelled out exactly as defaultProbeGithubAuth
// builds them — the shapes resolveGithubBootAuth must discriminate.
const OK = { ok: true, unauthorized: false, transient: false, reason: null };
const UNAUTHORIZED = { ok: false, unauthorized: true, transient: false, reason: "HTTP 401" };
const SPAWN_ERROR = { ok: false, unauthorized: false, transient: true, reason: "spawn gh ENOENT" };
const NON_401_EXIT = { ok: false, unauthorized: false, transient: true, reason: "gh exited 1" };
const TIMED_OUT = { ok: false, unauthorized: false, transient: true, reason: "spawnSync gh ETIMEDOUT" };

// recorder — captures probe calls (including the env object identity), alert
// payloads, and every log line, so a test can assert both "what happened" and
// "what was NEVER said".
function recorder() {
  const state = { probeEnvs: [], alerts: [], logs: [] };
  const push = (level) => (...a) => state.logs.push({ level, args: a });
  return {
    state,
    probeFor: (result) => (env) => {
      state.probeEnvs.push(env);
      return result;
    },
    emitAlert: (payload) => {
      state.alerts.push(payload);
      return true;
    },
    log: { debug: push("debug"), warn: push("warn"), error: push("error") },
    // Everything ever written to a log line, flattened — for "never leaked" asserts.
    loggedText: () => JSON.stringify(state.logs),
  };
}

// resolveWith — the standard injection harness: an explicit env + a fixed probe
// result + recording alert/log seams. `probe` may be overridden with a thrower.
function resolveWith(result, { env = {}, probe, emitAlert } = {}) {
  const rec = recorder();
  const out = resolveGithubBootAuth({
    env,
    probe: probe ?? rec.probeFor(result),
    emitAlert: emitAlert ?? rec.emitAlert,
    log: rec.log,
  });
  return { out, rec };
}

// ── isUnauthorizedOutput ──────────────────────────────────────────────────────

describe("isUnauthorizedOutput", () => {
  test("matches the real `gh` 401 line — both the HTTP 401 and the Bad credentials phrasing", () => {
    expect(isUnauthorizedOutput("gh: Bad credentials (HTTP 401)")).toBe(true);
    expect(isUnauthorizedOutput("HTTP 401: Bad credentials (https://api.github.com/rate_limit)")).toBe(true);
    expect(isUnauthorizedOutput("some noise\nHTTP 401\nmore noise")).toBe(true);
  });

  test("matches case-insensitively (a lowercased/uppercased variant is still a 401)", () => {
    expect(isUnauthorizedOutput("gh: bad credentials")).toBe(true);
    expect(isUnauthorizedOutput("GH: BAD CREDENTIALS (HTTP 401)")).toBe(true);
    expect(isUnauthorizedOutput("http 401")).toBe(true);
  });

  test("a 403 is NOT unauthorized — it is a scope/rate problem, never a dead credential", () => {
    expect(isUnauthorizedOutput("gh: Resource not accessible by integration (HTTP 403)")).toBe(false);
    expect(isUnauthorizedOutput("HTTP 403: API rate limit exceeded")).toBe(false);
  });

  test("a 5xx / generic failure is NOT unauthorized (transient — must stay silent)", () => {
    expect(isUnauthorizedOutput("HTTP 500: Internal Server Error")).toBe(false);
    expect(isUnauthorizedOutput("HTTP 502 Bad Gateway")).toBe(false);
    expect(isUnauthorizedOutput("dial tcp: lookup api.github.com: no such host")).toBe(false);
  });

  test("empty / null / undefined are NOT unauthorized (absence of output proves nothing)", () => {
    expect(isUnauthorizedOutput("")).toBe(false);
    expect(isUnauthorizedOutput(null)).toBe(false);
    expect(isUnauthorizedOutput(undefined)).toBe(false);
    expect(isUnauthorizedOutput("\n")).toBe(false);
  });

  test("word-boundary anchored: 'HTTP 4010' / 'HTTP 4013' do not masquerade as a 401", () => {
    expect(isUnauthorizedOutput("HTTP 4010")).toBe(false);
    expect(isUnauthorizedOutput("request id HTTP 40123 failed")).toBe(false);
  });
});

// ── defaultProbeGithubAuth (classification only — `gh` is never resolvable) ────

describe("defaultProbeGithubAuth", () => {
  test("the probe timeout is bounded (a hung api.github.com can never wedge boot)", () => {
    expect(Number.isFinite(GITHUB_PROBE_TIMEOUT_MS)).toBe(true);
    expect(GITHUB_PROBE_TIMEOUT_MS).toBeGreaterThan(0);
    expect(GITHUB_PROBE_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });

  test("an env whose PATH cannot resolve `gh` → TRANSIENT, never unauthorized, never throws", () => {
    // An empty dir as the ONLY PATH entry: `gh` cannot be found, so the spawn
    // fails locally and no request is ever made.
    const emptyBin = mkdtempSync(join(tmpdir(), "gh-preflight-emptybin-"));
    try {
      let r;
      expect(() => {
        r = defaultProbeGithubAuth({ PATH: emptyBin });
      }).not.toThrow();
      expect(r.ok).toBe(false);
      expect(r.unauthorized).toBe(false); // the load-bearing assertion: NOT a credential verdict
      expect(r.transient).toBe(true);
      expect(typeof r.reason).toBe("string");
      expect(r.reason.length).toBeGreaterThan(0);
    } finally {
      rmSync(emptyBin, { recursive: true, force: true });
    }
  });

  test("an unresolvable-`gh` probe result drives resolveGithubBootAuth to SILENCE (end-to-end)", () => {
    const emptyBin = mkdtempSync(join(tmpdir(), "gh-preflight-emptybin2-"));
    try {
      const rec = recorder();
      const out = resolveGithubBootAuth({
        env: { PATH: emptyBin, CATALYST_GITHUB_TOKEN_SOURCE: "shared-file" },
        probe: defaultProbeGithubAuth,
        emitAlert: rec.emitAlert,
        log: rec.log,
      });
      expect(rec.state.alerts).toHaveLength(0); // a missing binary NEVER pages the fleet
      expect(out).toEqual({ checked: true, ok: false, unauthorized: false, tokenSource: "shared-file" });
    } finally {
      rmSync(emptyBin, { recursive: true, force: true });
    }
  });
});

// ── resolveGithubBootAuth ─────────────────────────────────────────────────────

describe("resolveGithubBootAuth", () => {
  test("ok probe → no alert, returns {checked:true, ok:true}", () => {
    const { out, rec } = resolveWith(OK, { env: { CATALYST_GITHUB_TOKEN_SOURCE: "shared-file" } });
    expect(out).toEqual({ checked: true, ok: true, unauthorized: false, tokenSource: "shared-file" });
    expect(rec.state.alerts).toHaveLength(0);
    expect(rec.state.logs.filter((l) => l.level === "error")).toHaveLength(0);
  });

  test("the probe is called ONCE with the injected env object itself (process.env is never consulted)", () => {
    const env = { CATALYST_GITHUB_TOKEN_SOURCE: "inherited", PATH: "/nowhere" };
    const { rec } = resolveWith(OK, { env });
    expect(rec.state.probeEnvs).toHaveLength(1);
    expect(rec.state.probeEnvs[0]).toBe(env); // identity — the exact object, not a copy of process.env
  });

  test("unauthorized probe → emitAlert called EXACTLY once, tokenSource from env.CATALYST_GITHUB_TOKEN_SOURCE", () => {
    const { out, rec } = resolveWith(UNAUTHORIZED, {
      env: { CATALYST_GITHUB_TOKEN_SOURCE: "shared-file" },
    });
    expect(out).toEqual({ checked: true, ok: false, unauthorized: true, tokenSource: "shared-file" });
    expect(rec.state.alerts).toHaveLength(1);
    expect(rec.state.alerts[0].tokenSource).toBe("shared-file");
    expect(rec.state.alerts[0].reason).toBe("HTTP 401");
    expect(rec.state.logs.filter((l) => l.level === "error")).toHaveLength(1); // loud, once
  });

  test("the alert's tokenSource tracks the env breadcrumb ('inherited' / 'none'), never a fixed literal", () => {
    for (const source of ["inherited", "none"]) {
      const { out, rec } = resolveWith(UNAUTHORIZED, { env: { CATALYST_GITHUB_TOKEN_SOURCE: source } });
      expect(out.tokenSource).toBe(source);
      expect(rec.state.alerts).toHaveLength(1);
      expect(rec.state.alerts[0].tokenSource).toBe(source);
    }
  });

  test("missing env.CATALYST_GITHUB_TOKEN_SOURCE → tokenSource is 'unknown' (both in the verdict and the alert)", () => {
    const { out, rec } = resolveWith(UNAUTHORIZED, { env: {} });
    expect(out.tokenSource).toBe("unknown");
    expect(rec.state.alerts[0].tokenSource).toBe("unknown");
  });

  // THE anti-paging guarantee: a transient failure is NOT proof of a bad credential.
  test("transient probe (spawn error) → NO alert", () => {
    const { out, rec } = resolveWith(SPAWN_ERROR, { env: { CATALYST_GITHUB_TOKEN_SOURCE: "shared-file" } });
    expect(rec.state.alerts).toHaveLength(0);
    expect(out).toEqual({ checked: true, ok: false, unauthorized: false, tokenSource: "shared-file" });
  });

  test("transient probe (non-401 non-zero exit) → NO alert", () => {
    const { out, rec } = resolveWith(NON_401_EXIT, { env: { CATALYST_GITHUB_TOKEN_SOURCE: "inherited" } });
    expect(rec.state.alerts).toHaveLength(0);
    expect(out.unauthorized).toBe(false);
    expect(out.checked).toBe(true);
  });

  test("transient probe (timeout-shaped result) → NO alert", () => {
    const { out, rec } = resolveWith(TIMED_OUT, { env: { CATALYST_GITHUB_TOKEN_SOURCE: "shared-file" } });
    expect(rec.state.alerts).toHaveLength(0);
    expect(out.unauthorized).toBe(false);
  });

  test("a transient outcome still logs (a WARN), so the operator sees it without being paged", () => {
    const { rec } = resolveWith(TIMED_OUT, { env: {} });
    expect(rec.state.logs.filter((l) => l.level === "warn")).toHaveLength(1);
    expect(rec.state.logs.filter((l) => l.level === "error")).toHaveLength(0);
  });

  test("a malformed / empty probe result is treated as transient — no alert, no throw", () => {
    for (const bogus of [undefined, null, {}, { ok: false }, { unauthorized: "yes" }]) {
      const rec = recorder();
      let out;
      expect(() => {
        out = resolveGithubBootAuth({ env: {}, probe: () => bogus, emitAlert: rec.emitAlert, log: rec.log });
      }).not.toThrow();
      expect(rec.state.alerts).toHaveLength(0); // only unauthorized === true alerts
      expect(out.unauthorized).toBe(false);
    }
  });

  test("a probe that THROWS → never throws out, returns checked:false, and emits NO alert", () => {
    const rec = recorder();
    let out;
    expect(() => {
      out = resolveGithubBootAuth({
        env: { CATALYST_GITHUB_TOKEN_SOURCE: "shared-file" },
        probe: () => {
          throw new Error("probe boom");
        },
        emitAlert: rec.emitAlert,
        log: rec.log,
      });
    }).not.toThrow();
    expect(out).toEqual({ checked: false, ok: false, unauthorized: false, tokenSource: "shared-file" });
    expect(rec.state.alerts).toHaveLength(0);
    expect(rec.state.logs.filter((l) => l.level === "warn")).toHaveLength(1); // logged, not swallowed
  });

  test("an emitAlert that THROWS → resolveGithubBootAuth still does not throw and still reports unauthorized", () => {
    const rec = recorder();
    let out;
    expect(() => {
      out = resolveGithubBootAuth({
        env: { CATALYST_GITHUB_TOKEN_SOURCE: "shared-file" },
        probe: () => UNAUTHORIZED,
        emitAlert: () => {
          throw new Error("event log write boom");
        },
        log: rec.log,
      });
    }).not.toThrow();
    expect(out).toEqual({ checked: true, ok: false, unauthorized: true, tokenSource: "shared-file" });
    expect(rec.state.logs.filter((l) => l.level === "warn")).toHaveLength(1); // the emit failure is logged
  });

  test("advisory only: a missing log object and a no-op emitAlert never break boot", () => {
    expect(() => resolveGithubBootAuth({ env: {}, probe: () => OK, emitAlert: () => {}, log: null })).not.toThrow();
    expect(() => resolveGithubBootAuth({ env: {}, probe: () => TIMED_OUT, emitAlert: () => {}, log: {} })).not.toThrow();
    // Even the unauthorized path with a no-op log survives.
    expect(() =>
      resolveGithubBootAuth({ env: {}, probe: () => UNAUTHORIZED, emitAlert: () => {}, log: {} }),
    ).not.toThrow();
  });

  // Secret hygiene: the credential VALUE lives in the env we hand the probe. It
  // must never reach a log line or the alert payload — only the provenance
  // breadcrumb (tokenSource) is ever surfaced.
  test("never surfaces a credential value — only the tokenSource breadcrumb reaches the log/alert", () => {
    const { rec } = resolveWith(UNAUTHORIZED, {
      env: {
        GITHUB_TOKEN: FAKE_TOKEN,
        GH_TOKEN: FAKE_TOKEN,
        CATALYST_GITHUB_TOKEN_SOURCE: "shared-file",
      },
    });
    expect(rec.loggedText()).not.toContain(FAKE_TOKEN);
    expect(JSON.stringify(rec.state.alerts)).not.toContain(FAKE_TOKEN);
    expect(JSON.stringify(rec.state.alerts)).toContain("shared-file");
  });
});
