// github-auth-preflight.test.mjs — CTL-1612. FULLY OFFLINE: every test injects
// `probe` / `emitAlert` / `log` / `rearm` (or `readFile`) and an EXPLICIT `env`
// object, so no test ever reads process.env, spawns `gh`, reads the real shared
// credential file, appends to the event log, or touches the network. The one
// test that exercises the real `defaultProbeGithubAuth` points its injected PATH
// at an EMPTY temp dir, so `gh` cannot resolve and the probe classifies locally
// (never a request). Inherits test-setup.mjs.
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
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GITHUB_PROBE_TIMEOUT_MS,
  defaultGithubTokenFile,
  githubTokenFileCandidates,
  defaultProbeGithubAuth,
  isUnauthorizedOutput,
  rearmGithubTokenFromFile,
  resolveGithubBootAuth,
} from "./github-auth-preflight.mjs";

// ── Fakes ─────────────────────────────────────────────────────────────────────

// An obviously-fake credential literal. It exists ONLY so the hygiene test can
// prove no code path ever echoes a credential value into a log or an alert.
const FAKE_TOKEN = "ghp_THIS-IS-NOT-A-REAL-TOKEN-000000000000";

// The rotation pair for the re-arm tests: what the node booted holding (it was
// offline when the credential was rotated) vs what cluster-sync then wrote to
// disk. Both are obvious fakes; neither is ever expected in a log line.
const STALE_TOKEN = "ghp_STALE-FAKE-TOKEN-000000000000000000";
const ROTATED_TOKEN = "ghp_ROTATED-FAKE-TOKEN-11111111111111";
// A SECOND rotation, for the timer tests: proving the re-arm keeps working long
// after boot, not just the first time it runs.
const ROTATED_AGAIN_TOKEN = "ghp_ROTATED-AGAIN-FAKE-TOKEN-22222222";

// Obviously-fake credentials that CONTAIN whitespace. The reader used to strip ALL
// whitespace (`.replace(/\s+/g,"")` here, `tr -d '[:space:]'` on the shell side), which
// silently WELDS these into a different string — the value looks present and is simply
// wrong. A GitHub PAT never contains a space, but the same reader shape projects the
// webhook HMAC signing key, where a corrupted key rejects every inbound delivery with no
// error anywhere. `.trim()` is the fix; these literals pin it.
const SPACED_TOKEN = "ghp_FAKE TOKEN-WITH-A-SPACE-0000000";
const TABBED_TOKEN = "ghp_FAKE\tTOKEN-WITH-A-TAB-00000000000";
const MULTILINE_TOKEN = "ghp_FAKE-LINE-1-0000000\nghp_FAKE-LINE-2-0000000";

// A path that is NEVER opened — `readFile` is injected in every re-arm test, so
// this is only ever a map key and an assertion target.
const TOKEN_FILE = "/nowhere/catalyst/github-token";

// NO_REARM — the hermetic stand-in for `rearmGithubTokenFromFile` in the tests
// that are about `resolveGithubBootAuth`'s probe/alert contract. Without it the
// real re-arm would `readFileSync` the operator's actual shared credential file,
// making those tests host-dependent (present on a fleet node, absent on a laptop).
const NO_REARM = () => ({ rearmed: false, reason: "absent" });

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
function resolveWith(result, { env = {}, probe, emitAlert, rearm = NO_REARM } = {}) {
  const rec = recorder();
  const out = resolveGithubBootAuth({
    env,
    probe: probe ?? rec.probeFor(result),
    emitAlert: emitAlert ?? rec.emitAlert,
    log: rec.log,
    rearm,
  });
  return { out, rec };
}

// rearmWith — the injection harness for rearmGithubTokenFromFile: an explicit
// env (mutated in place, as production does) plus a `files` map standing in for
// the disk. A path absent from the map throws ENOENT, exactly as readFileSync
// would. `reads` records the paths asked for, so a test can prove the file was
// never even opened on the override path.
function rearmWith({ env, files = {} } = {}) {
  const rec = recorder();
  const reads = [];
  const out = rearmGithubTokenFromFile({
    env,
    readFile: (p) => {
      reads.push(p);
      if (!(p in files)) {
        const err = new Error(`ENOENT: no such file or directory, open '${p}'`);
        err.code = "ENOENT";
        throw err;
      }
      return files[p];
    },
    log: rec.log,
  });
  return { out, rec, reads };
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
        rearm: NO_REARM,
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
        out = resolveGithubBootAuth({
          env: {},
          probe: () => bogus,
          emitAlert: rec.emitAlert,
          log: rec.log,
          rearm: NO_REARM,
        });
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
        rearm: NO_REARM,
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
        rearm: NO_REARM,
      });
    }).not.toThrow();
    expect(out).toEqual({ checked: true, ok: false, unauthorized: true, tokenSource: "shared-file" });
    expect(rec.state.logs.filter((l) => l.level === "warn")).toHaveLength(1); // the emit failure is logged
  });

  test("advisory only: a missing log object and a no-op emitAlert never break boot", () => {
    const base = { env: {}, emitAlert: () => {}, rearm: NO_REARM };
    expect(() => resolveGithubBootAuth({ ...base, probe: () => OK, log: null })).not.toThrow();
    expect(() => resolveGithubBootAuth({ ...base, probe: () => TIMED_OUT, log: {} })).not.toThrow();
    // Even the unauthorized path with a no-op log survives.
    expect(() => resolveGithubBootAuth({ ...base, probe: () => UNAUTHORIZED, log: {} })).not.toThrow();
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

// ── defaultGithubTokenFile ────────────────────────────────────────────────────
//
// The resolution order must match the shell side byte for byte — the launcher's
// _project_shared_github_token and setup-webhooks.sh:23. A hardcoded ~/.config
// here would look at a DIFFERENT file than the one the operator's tooling wrote
// whenever XDG_CONFIG_HOME is set, and the re-arm would silently no-op.

describe("defaultGithubTokenFile", () => {
  test("CATALYST_GITHUB_TOKEN_FILE wins outright — even over XDG_CONFIG_HOME and HOME", () => {
    expect(
      defaultGithubTokenFile({
        CATALYST_GITHUB_TOKEN_FILE: "/etc/catalyst/explicit-github-token",
        XDG_CONFIG_HOME: "/xdg-config",
        HOME: "/home/fake",
      }),
    ).toBe("/etc/catalyst/explicit-github-token");
  });

  // CTL-1612 (Codex P1, round 2): cluster-sync — the thing that actually WRITES this
  // file — resolves its destination from dirname(getLayer2ConfigPath()), whose default is
  // hardcoded ~/.config/catalyst and is NOT XDG-aware. Preferring the XDG path would make
  // an XDG host miss every rotation, which is strictly worse than the hardcoded read it
  // replaced. So the writer's destination is FIRST and XDG is a fallback.
  test("the cluster-sync destination outranks XDG_CONFIG_HOME (the writer is not XDG-aware)", () => {
    expect(defaultGithubTokenFile({ XDG_CONFIG_HOME: "/xdg-config", HOME: "/home/fake" })).toBe(
      join("/home/fake", ".config", "catalyst", "github-token"),
    );
  });

  test("XDG_CONFIG_HOME is still offered as a FALLBACK candidate, after the writer's dir", () => {
    expect(githubTokenFileCandidates({ XDG_CONFIG_HOME: "/xdg-config", HOME: "/home/fake" })).toEqual([
      join("/home/fake", ".config", "catalyst", "github-token"),
      join("/xdg-config", "catalyst", "github-token"),
    ]);
  });

  test("CATALYST_LAYER2_CONFIG_FILE moves the primary candidate, mirroring the writer", () => {
    expect(
      githubTokenFileCandidates({
        CATALYST_LAYER2_CONFIG_FILE: "/opt/cfg/catalyst/config.json",
        HOME: "/home/fake",
      })[0],
    ).toBe(join("/opt/cfg/catalyst", "github-token"));
  });

  test("falls back to $HOME/.config when XDG_CONFIG_HOME is unset", () => {
    expect(defaultGithubTokenFile({ HOME: "/home/fake" })).toBe(
      join("/home/fake", ".config", "catalyst", "github-token"),
    );
  });

  test("an EMPTY XDG_CONFIG_HOME is ignored (falsy, exactly like ${XDG_CONFIG_HOME:-...})", () => {
    expect(defaultGithubTokenFile({ XDG_CONFIG_HOME: "", HOME: "/home/fake" })).toBe(
      join("/home/fake", ".config", "catalyst", "github-token"),
    );
  });
});

// ── rearmGithubTokenFromFile ──────────────────────────────────────────────────
//
// THE CTL-1612 P1 REGRESSION. A node that was OFFLINE during a credential
// rotation boots holding the stale local copy; daemon boot then runs clusterSync,
// which materializes the replacement onto disk — and, before this, nothing
// re-read it. The daemon 401'd until a SECOND manual restart. Every test here
// injects `readFile` and mutates an EXPLICIT env object: the real shared
// credential file is never opened.

describe("rearmGithubTokenFromFile", () => {
  test("REGRESSION: a rotation materialized after launch re-arms BOTH env names in place", () => {
    const env = {
      CATALYST_GITHUB_TOKEN_FILE: TOKEN_FILE,
      CATALYST_GITHUB_TOKEN_SOURCE: "shared-file",
      GITHUB_TOKEN: STALE_TOKEN,
      GH_TOKEN: STALE_TOKEN,
    };
    const { out, rec, reads } = rearmWith({ env, files: { [TOKEN_FILE]: ROTATED_TOKEN } });

    expect(out).toEqual({ rearmed: true, reason: "rotated" });
    expect(env.GITHUB_TOKEN).toBe(ROTATED_TOKEN);
    expect(env.GH_TOKEN).toBe(ROTATED_TOKEN); // both — `gh` resolves GH_TOKEN first
    expect(env.CATALYST_GITHUB_TOKEN_SOURCE).toBe("shared-file-resynced");
    expect(reads).toEqual([TOKEN_FILE]); // read the resolved path, exactly once
    // Hygiene: the re-arm is loud about the FACT of a rotation, never its value.
    expect(rec.loggedText()).not.toContain(ROTATED_TOKEN);
    expect(rec.loggedText()).not.toContain(STALE_TOKEN);
    expect(rec.state.logs.filter((l) => l.level === "warn")).toHaveLength(1);
  });

  test("a LAGGING GH_TOKEN alone still re-arms (gh reads GH_TOKEN first — a half-match is a live 401)", () => {
    const env = {
      CATALYST_GITHUB_TOKEN_FILE: TOKEN_FILE,
      GITHUB_TOKEN: ROTATED_TOKEN, // already current
      GH_TOKEN: STALE_TOKEN, // …but this is the one `gh` actually uses
    };
    const { out } = rearmWith({ env, files: { [TOKEN_FILE]: ROTATED_TOKEN } });

    expect(out).toEqual({ rearmed: true, reason: "rotated" });
    expect(env.GH_TOKEN).toBe(ROTATED_TOKEN);
    expect(env.GITHUB_TOKEN).toBe(ROTATED_TOKEN);
  });

  test("content identical to BOTH env names → no mutation at all, {rearmed:false, reason:'unchanged'}", () => {
    const env = {
      CATALYST_GITHUB_TOKEN_FILE: TOKEN_FILE,
      CATALYST_GITHUB_TOKEN_SOURCE: "shared-file",
      GITHUB_TOKEN: STALE_TOKEN,
      GH_TOKEN: STALE_TOKEN,
    };
    const { out, rec } = rearmWith({ env, files: { [TOKEN_FILE]: STALE_TOKEN } });

    expect(out).toEqual({ rearmed: false, reason: "unchanged" });
    expect(env.GITHUB_TOKEN).toBe(STALE_TOKEN);
    expect(env.GH_TOKEN).toBe(STALE_TOKEN);
    expect(env.CATALYST_GITHUB_TOKEN_SOURCE).toBe("shared-file"); // breadcrumb NOT rewritten
    expect(rec.state.logs).toHaveLength(0); // a steady-state boot stays quiet
  });

  test("a cosmetic trailing newline is stripped — not mistaken for a rotation", () => {
    const env = {
      CATALYST_GITHUB_TOKEN_FILE: TOKEN_FILE,
      GITHUB_TOKEN: FAKE_TOKEN,
      GH_TOKEN: FAKE_TOKEN,
      CATALYST_GITHUB_TOKEN_SOURCE: "shared-file",
    };
    const { out } = rearmWith({ env, files: { [TOKEN_FILE]: `${FAKE_TOKEN}\n` } });
    expect(out).toEqual({ rearmed: false, reason: "unchanged" });
    expect(env.CATALYST_GITHUB_TOKEN_SOURCE).toBe("shared-file");
  });

  // CTL-1612 (round 5): ALL trailing terminators, not just the last. The bash launcher
  // reads via `$(cat …)`, which eats EVERY trailing newline — a file ending in `\n\n`
  // installed the bare token at boot, but a single-terminator re-arm produced `token\n`,
  // handing boot-resumed workers and every subsequent `gh` call an invalid credential.
  test("REGRESSION: multiple trailing newlines (LF and CRLF) all strip — re-arm matches the launcher", () => {
    for (const tail of ["\n\n", "\n\n\n", "\r\n\r\n"]) {
      const env = { CATALYST_GITHUB_TOKEN_FILE: TOKEN_FILE, GITHUB_TOKEN: STALE_TOKEN };
      const { out } = rearmWith({ env, files: { [TOKEN_FILE]: `${ROTATED_TOKEN}${tail}` } });
      expect(out).toEqual({ rearmed: true, reason: "rotated" });
      expect(env.GITHUB_TOKEN).toBe(ROTATED_TOKEN); // bare token, no residual terminator
      expect(env.GH_TOKEN).toBe(ROTATED_TOKEN);
    }
    // And the no-op direction: a multi-newline file whose bare value matches the env
    // must read as "unchanged", not as a phantom rotation.
    const env = {
      CATALYST_GITHUB_TOKEN_FILE: TOKEN_FILE,
      GITHUB_TOKEN: FAKE_TOKEN,
      GH_TOKEN: FAKE_TOKEN,
      CATALYST_GITHUB_TOKEN_SOURCE: "shared-file",
    };
    const { out } = rearmWith({ env, files: { [TOKEN_FILE]: `${FAKE_TOKEN}\n\n` } });
    expect(out).toEqual({ rearmed: false, reason: "unchanged" });
  });

  // CTL-1612 (round 4): ONLY the line terminator is stripped. A credential may legitimately
  // begin or end with a space or tab, and trimming those bytes yields a different key —
  // for an HMAC secret that silently rejects every correctly-signed delivery. The `$(cat)`
  // this replaced preserved boundary spaces, so trimming them would be a regression.
  test("the trailing NEWLINE is stripped but significant boundary whitespace survives", () => {
    const env = { CATALYST_GITHUB_TOKEN_FILE: TOKEN_FILE, GITHUB_TOKEN: STALE_TOKEN };
    const withEdges = `  ${ROTATED_TOKEN}\t`;
    const { out } = rearmWith({ env, files: { [TOKEN_FILE]: `${withEdges}\n` } });
    expect(out).toEqual({ rearmed: true, reason: "rotated" });
    expect(env.GITHUB_TOKEN).toBe(withEdges); // byte-for-byte, edges intact
    expect(env.GH_TOKEN).toBe(withEdges);
    expect(env.GITHUB_TOKEN.endsWith("\n")).toBe(false); // the EOL is gone
  });

  // An empty install is WORSE than no install: "" reads as SET to `??` and
  // `${X:-}`, so it would defeat gh's hosts.yml/keyring fallback.
  test("an empty / whitespace-only file NEVER installs '' — env untouched, {rearmed:false, reason:'empty'}", () => {
    for (const content of ["", "\n", "   \t\n  "]) {
      const env = {
        CATALYST_GITHUB_TOKEN_FILE: TOKEN_FILE,
        CATALYST_GITHUB_TOKEN_SOURCE: "shared-file",
        GITHUB_TOKEN: STALE_TOKEN,
        GH_TOKEN: STALE_TOKEN,
      };
      const { out } = rearmWith({ env, files: { [TOKEN_FILE]: content } });

      expect(out).toEqual({ rearmed: false, reason: "empty" });
      expect(env.GITHUB_TOKEN).toBe(STALE_TOKEN);
      expect(env.GH_TOKEN).toBe(STALE_TOKEN);
      expect(env.CATALYST_GITHUB_TOKEN_SOURCE).toBe("shared-file");
    }
  });

  test("an ABSENT file (readFile throws) → {rearmed:false, reason:'absent'}, env untouched, never throws", () => {
    const env = {
      CATALYST_GITHUB_TOKEN_FILE: TOKEN_FILE,
      CATALYST_GITHUB_TOKEN_SOURCE: "inherited",
      GITHUB_TOKEN: STALE_TOKEN,
      GH_TOKEN: STALE_TOKEN,
    };
    let out;
    expect(() => {
      ({ out } = rearmWith({ env, files: {} })); // nothing on disk → ENOENT
    }).not.toThrow();

    expect(out).toEqual({ rearmed: false, reason: "absent" });
    expect(env.GITHUB_TOKEN).toBe(STALE_TOKEN);
    expect(env.GH_TOKEN).toBe(STALE_TOKEN);
    expect(env.CATALYST_GITHUB_TOKEN_SOURCE).toBe("inherited");
  });

  // The operator override is the whole point of the T2 ordering fix: a human who
  // pinned a credential in execution-core.env must not have it clobbered by the
  // shared file, no matter what cluster-sync just materialized.
  test("an operator override SURVIVES — no mutation, and the file is never even opened", () => {
    const env = {
      CATALYST_GITHUB_TOKEN_FILE: TOKEN_FILE,
      CATALYST_GITHUB_TOKEN_SOURCE: "operator-override",
      GITHUB_TOKEN: STALE_TOKEN,
      GH_TOKEN: STALE_TOKEN,
    };
    const { out, reads } = rearmWith({ env, files: { [TOKEN_FILE]: ROTATED_TOKEN } });

    expect(out).toEqual({ rearmed: false, reason: "operator-override" });
    expect(env.GITHUB_TOKEN).toBe(STALE_TOKEN);
    expect(env.GH_TOKEN).toBe(STALE_TOKEN);
    expect(env.CATALYST_GITHUB_TOKEN_SOURCE).toBe("operator-override");
    expect(reads).toHaveLength(0); // short-circuits before any read
  });

  test("tries the cluster-sync destination FIRST, then falls back to the XDG path", () => {
    const env = { XDG_CONFIG_HOME: "/xdg-config", HOME: "/home/fake" };
    const { reads } = rearmWith({ env, files: {} });
    expect(reads).toEqual([
      join("/home/fake", ".config", "catalyst", "github-token"),
      join("/xdg-config", "catalyst", "github-token"),
    ]);
  });

  // The writers disagree, so a host can legitimately have the credential in EITHER
  // place. Whichever exists must be found — this is the XDG-host rotation case.
  test("finds the credential when only the XDG copy exists", () => {
    const env = { XDG_CONFIG_HOME: "/xdg-config", HOME: "/home/fake", GITHUB_TOKEN: STALE_TOKEN };
    const xdgPath = join("/xdg-config", "catalyst", "github-token");
    const out = rearmGithubTokenFromFile({
      env,
      readFile: (p) => {
        if (p === xdgPath) return ROTATED_TOKEN;
        throw new Error("ENOENT");
      },
      log: null,
    });
    expect(out).toEqual({ rearmed: true, reason: "rotated" });
    expect(env.GITHUB_TOKEN).toBe(ROTATED_TOKEN);
    expect(env.GH_TOKEN).toBe(ROTATED_TOKEN);
  });

  test("advisory only: a missing log never breaks the re-arm", () => {
    const env = { CATALYST_GITHUB_TOKEN_FILE: TOKEN_FILE, GITHUB_TOKEN: STALE_TOKEN, GH_TOKEN: STALE_TOKEN };
    let out;
    expect(() => {
      out = rearmGithubTokenFromFile({
        env,
        readFile: () => ROTATED_TOKEN,
        log: null,
      });
    }).not.toThrow();
    expect(out).toEqual({ rearmed: true, reason: "rotated" });
    expect(env.GH_TOKEN).toBe(ROTATED_TOKEN);
  });
});

// ── rearmGithubTokenFromFile: whitespace fidelity ─────────────────────────────
//
// THE ROUND-3 DATA-CORRUPTION REGRESSION. The reader used to normalize the file with
// `.replace(/\s+/g, "")` — which does NOT mean "drop the trailing newline", it means
// "delete every whitespace character anywhere in the value". A secret containing a
// space, a tab or an internal newline was therefore installed as a DIFFERENT string
// than the one on disk: present, plausible-looking, and wrong. There is no error
// anywhere in that failure mode — the credential is simply rejected forever.
//
// The contract is now exactly `.trim()`: surrounding whitespace goes (so a cosmetic
// trailing newline is never mistaken for a rotation), internal whitespace stays
// (so the installed value is byte-for-byte what the writer wrote).

describe("rearmGithubTokenFromFile preserves INTERNAL whitespace", () => {
  const withInternalWhitespace = [
    ["a space", SPACED_TOKEN],
    ["a tab", TABBED_TOKEN],
    ["an internal newline", MULTILINE_TOKEN],
  ];

  for (const [label, value] of withInternalWhitespace) {
    test(`REGRESSION: a credential containing ${label} installs BYTE-FOR-BYTE`, () => {
      const env = {
        CATALYST_GITHUB_TOKEN_FILE: TOKEN_FILE,
        CATALYST_GITHUB_TOKEN_SOURCE: "shared-file",
        GITHUB_TOKEN: STALE_TOKEN,
        GH_TOKEN: STALE_TOKEN,
      };
      const { out, rec } = rearmWith({ env, files: { [TOKEN_FILE]: value } });

      expect(out).toEqual({ rearmed: true, reason: "rotated" });
      expect(env.GITHUB_TOKEN).toBe(value);
      expect(env.GH_TOKEN).toBe(value); // both names, both intact
      // The exact shape the strip-everything reader produced. Asserting the negative
      // is what makes this a regression test rather than a restatement of `.trim()`.
      expect(env.GITHUB_TOKEN).not.toBe(value.replace(/\s+/g, ""));
      expect(rec.loggedText()).not.toContain(value); // still never echoes the value
    });
  }

  test("REGRESSION: internal AND boundary whitespace both survive; only the EOL is removed", () => {
    const env = { CATALYST_GITHUB_TOKEN_FILE: TOKEN_FILE, GITHUB_TOKEN: STALE_TOKEN };
    const value = " tok with a space \t";
    const { out } = rearmWith({ env, files: { [TOKEN_FILE]: `${value}\n` } });
    expect(out).toEqual({ rearmed: true, reason: "rotated" });
    expect(env.GITHUB_TOKEN).toBe(value);
    expect(env.GITHUB_TOKEN).toContain(" ");
    expect(env.GITHUB_TOKEN).not.toBe(value.replace(/\s+/g, "")); // not the old corruption
    expect(env.GITHUB_TOKEN).not.toBe(value.trim()); // and not the round-3 over-trim
  });

  test("an internal-whitespace credential already installed is 'unchanged' — no churn per tick", () => {
    const env = {
      CATALYST_GITHUB_TOKEN_FILE: TOKEN_FILE,
      CATALYST_GITHUB_TOKEN_SOURCE: "shared-file",
      GITHUB_TOKEN: SPACED_TOKEN,
      GH_TOKEN: SPACED_TOKEN,
    };
    // Trailing newline only — the comparison must see through it, or every tick would
    // "rotate" and log a rotation warning that never happened.
    const { out, rec } = rearmWith({ env, files: { [TOKEN_FILE]: `${SPACED_TOKEN}\n` } });

    expect(out).toEqual({ rearmed: false, reason: "unchanged" });
    expect(env.CATALYST_GITHUB_TOKEN_SOURCE).toBe("shared-file"); // breadcrumb NOT rewritten
    expect(rec.state.logs).toHaveLength(0);
  });

  // Whitespace is not a credential. Trimming to "" must land on the `empty` guard, not
  // install a blank that reads as SET to `??` / `${X:-}` and defeats gh's own fallback.
  test("a whitespace-ONLY file is still empty — no install, {rearmed:false, reason:'empty'}", () => {
    for (const content of [" ", "\t", "\r\n", "\n\n\n", " \t \r\n  "]) {
      const env = {
        CATALYST_GITHUB_TOKEN_FILE: TOKEN_FILE,
        CATALYST_GITHUB_TOKEN_SOURCE: "shared-file",
        GITHUB_TOKEN: STALE_TOKEN,
        GH_TOKEN: STALE_TOKEN,
      };
      const { out } = rearmWith({ env, files: { [TOKEN_FILE]: content } });

      expect(out).toEqual({ rearmed: false, reason: "empty" });
      expect(env.GITHUB_TOKEN).toBe(STALE_TOKEN);
      expect(env.GH_TOKEN).toBe(STALE_TOKEN);
      expect(env.CATALYST_GITHUB_TOKEN_SOURCE).toBe("shared-file");
    }
  });
});

// ── rearmGithubTokenFromFile on EVERY cluster-sync tick ───────────────────────
//
// CTL-1612 round 3: the re-arm moved from boot-only to every periodic cluster-sync
// timer tick. Boot-only would have converted a silent failure into a loud one that
// STILL needs hands — a credential rotated at 03:00 on a daemon that booted at 00:00
// stays dead until a human restarts it. Running per tick makes two properties
// load-bearing that a boot-only call never had to satisfy:
//   1. IDEMPOTENCE — the steady-state tick must mutate nothing and say nothing, or the
//      daemon rewrites its own env and logs a phantom rotation every interval;
//   2. LATENESS — a rotation that first appears on the Nth tick must still re-arm,
//      exactly as the first one did.
// These call the real function repeatedly against one env, which is what the timer does.

describe("rearmGithubTokenFromFile on every timer tick", () => {
  // writeRecordingEnv — an env that records every assignment, so "mutates nothing" is
  // asserted directly rather than inferred from values that happen to still match.
  function writeRecordingEnv(initial) {
    const writes = [];
    const env = new Proxy(
      { ...initial },
      {
        set(target, key, value) {
          writes.push(key);
          target[key] = value;
          return true;
        },
      },
    );
    return { env, writes };
  }

  // tickHarness — one env plus a mutable stand-in for the disk. `disk.content = null`
  // means the file does not exist yet (readFile throws, as readFileSync would).
  function tickHarness(initial, content) {
    const { env, writes } = writeRecordingEnv(initial);
    const disk = { content };
    const rec = recorder();
    const tick = () =>
      rearmGithubTokenFromFile({
        env,
        readFile: () => {
          if (disk.content === null) {
            const err = new Error(`ENOENT: no such file or directory, open '${TOKEN_FILE}'`);
            err.code = "ENOENT";
            throw err;
          }
          return disk.content;
        },
        log: rec.log,
      });
    return { env, writes, disk, rec, tick };
  }

  const BASE = { CATALYST_GITHUB_TOKEN_FILE: TOKEN_FILE, CATALYST_GITHUB_TOKEN_SOURCE: "shared-file" };

  test("REGRESSION: a steady-state second tick mutates NOTHING and returns reason:'unchanged'", () => {
    const { env, writes, rec, tick } = tickHarness(
      { ...BASE, GITHUB_TOKEN: STALE_TOKEN, GH_TOKEN: STALE_TOKEN },
      `${ROTATED_TOKEN}\n`,
    );

    expect(tick()).toEqual({ rearmed: true, reason: "rotated" }); // tick 1 installs
    const afterFirst = writes.length;
    expect(afterFirst).toBe(3); // GITHUB_TOKEN, GH_TOKEN, CATALYST_GITHUB_TOKEN_SOURCE

    expect(tick()).toEqual({ rearmed: false, reason: "unchanged" }); // tick 2 no-ops
    expect(tick()).toEqual({ rearmed: false, reason: "unchanged" }); // …and stays no-op
    expect(writes).toHaveLength(afterFirst); // not one further assignment
    expect(env.GITHUB_TOKEN).toBe(ROTATED_TOKEN);
    expect(env.GH_TOKEN).toBe(ROTATED_TOKEN);
    expect(env.CATALYST_GITHUB_TOKEN_SOURCE).toBe("shared-file-resynced");
    expect(rec.state.logs.filter((l) => l.level === "warn")).toHaveLength(1); // one rotation, one line
  });

  test("REGRESSION: a rotation landing on a LATER tick re-arms and stamps 'shared-file-resynced'", () => {
    const { env, disk, rec, tick } = tickHarness(
      { ...BASE, GITHUB_TOKEN: STALE_TOKEN, GH_TOKEN: STALE_TOKEN },
      `${ROTATED_TOKEN}\n`,
    );

    expect(tick()).toEqual({ rearmed: true, reason: "rotated" });
    expect(tick()).toEqual({ rearmed: false, reason: "unchanged" });
    expect(env.GITHUB_TOKEN).toBe(ROTATED_TOKEN);

    // 03:00: cluster-sync materializes the NEXT rotation onto disk under a long-running
    // daemon. Boot already happened hours ago; only the timer can catch this.
    disk.content = `${ROTATED_AGAIN_TOKEN}\n`;

    expect(tick()).toEqual({ rearmed: true, reason: "rotated" });
    expect(env.GITHUB_TOKEN).toBe(ROTATED_AGAIN_TOKEN);
    expect(env.GH_TOKEN).toBe(ROTATED_AGAIN_TOKEN);
    expect(env.CATALYST_GITHUB_TOKEN_SOURCE).toBe("shared-file-resynced");
    expect(rec.state.logs.filter((l) => l.level === "warn")).toHaveLength(2); // one per real rotation
    expect(rec.loggedText()).not.toContain(ROTATED_TOKEN);
    expect(rec.loggedText()).not.toContain(ROTATED_AGAIN_TOKEN);
  });

  test("a file that does not exist at boot but appears LATER is picked up by a subsequent tick", () => {
    const { env, writes, disk, tick } = tickHarness(
      { ...BASE, GITHUB_TOKEN: STALE_TOKEN, GH_TOKEN: STALE_TOKEN },
      null, // nothing on disk yet — cluster-sync has not materialized it
    );

    expect(tick()).toEqual({ rearmed: false, reason: "absent" });
    expect(writes).toHaveLength(0); // absent must not touch the env at all
    expect(env.GITHUB_TOKEN).toBe(STALE_TOKEN);

    disk.content = ROTATED_TOKEN;

    expect(tick()).toEqual({ rearmed: true, reason: "rotated" });
    expect(env.GITHUB_TOKEN).toBe(ROTATED_TOKEN);
    expect(env.GH_TOKEN).toBe(ROTATED_TOKEN);
  });

  test("an operator override is honored on EVERY tick — never clobbered by a later rotation", () => {
    const { env, writes, disk, tick } = tickHarness(
      {
        CATALYST_GITHUB_TOKEN_FILE: TOKEN_FILE,
        CATALYST_GITHUB_TOKEN_SOURCE: "operator-override",
        GITHUB_TOKEN: STALE_TOKEN,
        GH_TOKEN: STALE_TOKEN,
      },
      `${ROTATED_TOKEN}\n`,
    );

    for (let i = 0; i < 3; i += 1) {
      expect(tick()).toEqual({ rearmed: false, reason: "operator-override" });
    }
    disk.content = `${ROTATED_AGAIN_TOKEN}\n`;
    expect(tick()).toEqual({ rearmed: false, reason: "operator-override" });

    expect(writes).toHaveLength(0);
    expect(env.GITHUB_TOKEN).toBe(STALE_TOKEN);
    expect(env.CATALYST_GITHUB_TOKEN_SOURCE).toBe("operator-override");
  });

  test("an internal-whitespace credential survives repeated ticks unchanged (no per-tick corruption)", () => {
    const { env, writes, rec, tick } = tickHarness(
      { ...BASE, GITHUB_TOKEN: STALE_TOKEN, GH_TOKEN: STALE_TOKEN },
      `${TABBED_TOKEN}\n`,
    );

    expect(tick()).toEqual({ rearmed: true, reason: "rotated" });
    const afterFirst = writes.length;
    // Under the strip-everything reader the installed value never equals the file, so
    // every subsequent tick would "rotate" again forever.
    expect(tick()).toEqual({ rearmed: false, reason: "unchanged" });
    expect(tick()).toEqual({ rearmed: false, reason: "unchanged" });
    expect(writes).toHaveLength(afterFirst);
    expect(env.GITHUB_TOKEN).toBe(TABBED_TOKEN);
    expect(rec.state.logs.filter((l) => l.level === "warn")).toHaveLength(1);
  });
});

// ── resolveGithubBootAuth ⟷ rearm wiring ──────────────────────────────────────
//
// Re-arming AFTER the probe would be worthless: the preflight must verify the
// credential it will actually use, not the one the launcher happened to project.

describe("resolveGithubBootAuth re-arms before probing", () => {
  test("REGRESSION: rearm runs BEFORE probe, and the probe observes the RE-ARMED credential", () => {
    const order = [];
    const env = {
      CATALYST_GITHUB_TOKEN_SOURCE: "shared-file",
      GITHUB_TOKEN: STALE_TOKEN,
      GH_TOKEN: STALE_TOKEN,
    };
    const rec = recorder();
    let seenByProbe;

    const out = resolveGithubBootAuth({
      env,
      rearm: ({ env: e }) => {
        order.push("rearm");
        e.GITHUB_TOKEN = ROTATED_TOKEN;
        e.GH_TOKEN = ROTATED_TOKEN;
        e.CATALYST_GITHUB_TOKEN_SOURCE = "shared-file-resynced";
        return { rearmed: true, reason: "rotated" };
      },
      probe: (e) => {
        order.push("probe");
        seenByProbe = { ...e };
        return OK;
      },
      emitAlert: rec.emitAlert,
      log: rec.log,
    });

    expect(order).toEqual(["rearm", "probe"]); // ordering is the fix
    expect(seenByProbe.GITHUB_TOKEN).toBe(ROTATED_TOKEN);
    expect(seenByProbe.GH_TOKEN).toBe(ROTATED_TOKEN);
    // And the verdict reports the POST-rearm provenance, not the launcher's.
    expect(out).toEqual({
      checked: true,
      ok: true,
      unauthorized: false,
      tokenSource: "shared-file-resynced",
    });
    expect(rec.state.alerts).toHaveLength(0);
  });

  test("rearm receives the SAME env object it must mutate, plus the injected log", () => {
    const env = { CATALYST_GITHUB_TOKEN_SOURCE: "shared-file" };
    const rec = recorder();
    const seen = [];

    resolveGithubBootAuth({
      env,
      rearm: (args) => {
        seen.push(args);
        return { rearmed: false, reason: "unchanged" };
      },
      probe: () => OK,
      emitAlert: rec.emitAlert,
      log: rec.log,
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].env).toBe(env); // identity — in-place mutation must be visible
    expect(seen[0].log).toBe(rec.log);
  });

  test("a rearm that THROWS does not break boot — the probe still runs and a verdict is returned", () => {
    const rec = recorder();
    let out;
    expect(() => {
      out = resolveGithubBootAuth({
        env: { CATALYST_GITHUB_TOKEN_SOURCE: "shared-file" },
        rearm: () => {
          throw new Error("cluster-sync wrote a half-file");
        },
        probe: rec.probeFor(OK),
        emitAlert: rec.emitAlert,
        log: rec.log,
      });
    }).not.toThrow();

    expect(rec.state.probeEnvs).toHaveLength(1); // the probe was NOT skipped
    expect(out).toEqual({ checked: true, ok: true, unauthorized: false, tokenSource: "shared-file" });
    expect(rec.state.alerts).toHaveLength(0);
    expect(rec.state.logs.filter((l) => l.level === "warn")).toHaveLength(1); // logged, not swallowed
  });

  test("a re-armed credential that is STILL rejected alerts once, carrying the resynced breadcrumb", () => {
    const rec = recorder();
    const env = { CATALYST_GITHUB_TOKEN_SOURCE: "shared-file", GITHUB_TOKEN: STALE_TOKEN };
    const out = resolveGithubBootAuth({
      env,
      rearm: ({ env: e }) => {
        e.GITHUB_TOKEN = ROTATED_TOKEN;
        e.GH_TOKEN = ROTATED_TOKEN;
        e.CATALYST_GITHUB_TOKEN_SOURCE = "shared-file-resynced";
        return { rearmed: true, reason: "rotated" };
      },
      probe: () => UNAUTHORIZED,
      emitAlert: rec.emitAlert,
      log: rec.log,
    });

    expect(out.unauthorized).toBe(true);
    expect(rec.state.alerts).toHaveLength(1);
    expect(rec.state.alerts[0].tokenSource).toBe("shared-file-resynced");
    expect(rec.loggedText()).not.toContain(ROTATED_TOKEN);
    expect(JSON.stringify(rec.state.alerts)).not.toContain(ROTATED_TOKEN);
  });
});

// ── daemon boot ORDERING (CTL-1612, Codex P1 round 2; CTL-1623: call sites now route
// through armSecret) ────────────────────────────────────────────────────────────────────
//
// The preflight's placement in daemon.mjs is load-bearing, and both directions have
// already been wrong once:
//   * originally it ran BEFORE the boot clusterSync, so a node offline during a rotation
//     probed the stale credential and never saw the replacement the sync put on disk;
//   * moving it after the sync then left it AFTER reconcileBoot/processApprovedResumes,
//     which dispatch workers synchronously — and dispatch.mjs spawns them with
//     ...process.env, so every resumed worker inherited the stale credential for life.
// The only correct window is: clusterSync → preflight → any dispatch. A structural
// assertion is the honest way to pin that; a unit test cannot observe boot ordering.
//
// CTL-1623: both call sites were re-pointed from a direct rearmGithubTokenFromFile() call
// to armSecret("github-token", { env: process.env }) — routing through the registry's arm
// path so the registerRearmHook-registered hook (== rearmGithubTokenFromFile itself, wired
// at module load, see the "rearm hook registration" describe block below) actually fires.
// The needle strings below track that rename; the ordering invariants themselves are
// unchanged.
describe("daemon boot ordering", () => {
  const daemonSrc = readFileSync(new URL("./daemon.mjs", import.meta.url), "utf8").split("\n");
  const lineOf = (needle) => daemonSrc.findIndex((l) => l.includes(needle));
  const countOf = (needle) => daemonSrc.filter((l) => l.includes(needle)).length;
  const REARM_CALL = 'armSecret("github-token", { env: process.env });';

  // The boot sequence must be: clusterSync -> RE-ARM -> dispatch -> PROBE.
  // Both halves are load-bearing and both have been wrong once:
  //   * re-arm must precede dispatch, or a boot-resumed worker inherits a credential the
  //     sync just superseded and keeps it for its whole lifetime;
  //   * the probe must FOLLOW dispatch, because it spawns `gh` with a 10s timeout and a
  //     network round-trip ahead of crash recovery delays re-dispatching in-flight work
  //     for no diagnostic benefit.
  test("the boot cluster-sync runs BEFORE the credential re-arm", () => {
    const sync = lineOf("const bootSync = clusterSync()");
    const rearm = lineOf(REARM_CALL);
    expect(sync).toBeGreaterThan(-1);
    expect(rearm).toBeGreaterThan(-1);
    expect(sync).toBeLessThan(rearm);
  });

  test("the credential RE-ARM runs BEFORE anything dispatches a worker", () => {
    const rearm = lineOf(REARM_CALL);
    const bootResume = lineOf("const bootResume = reconcileBoot(");
    const approved = lineOf("processApprovedResumes({ orchDir, dispatch: dispatchFn })");
    expect(bootResume).toBeGreaterThan(-1);
    expect(approved).toBeGreaterThan(-1);
    expect(rearm).toBeLessThan(bootResume);
    expect(rearm).toBeLessThan(approved);
  });

  test("the `gh` PROBE runs AFTER the dispatches (never delays crash recovery)", () => {
    const probe = lineOf("githubAuthPreflight({ env: process.env, log })");
    const bootResume = lineOf("const bootResume = reconcileBoot(");
    const approved = lineOf("processApprovedResumes({ orchDir, dispatch: dispatchFn })");
    expect(probe).toBeGreaterThan(bootResume);
    expect(probe).toBeGreaterThan(approved);
  });

  test("the probe is wired exactly once (no leftover duplicate call site)", () => {
    expect(countOf("githubAuthPreflight({")).toBe(1);
  });

  // Without this the entire fix is boot-only: a credential rotated at 03:00 on a daemon
  // that booted at 00:00 stays dead until a human restarts it.
  test("the re-arm is ALSO wired into the periodic cluster-sync timer", () => {
    const timer = lineOf("_clusterSyncTimer = setInterval(");
    expect(timer).toBeGreaterThan(-1);
    const rearmCalls = daemonSrc.map((l, i) => (l.includes(REARM_CALL) ? i : -1)).filter((i) => i >= 0);
    expect(rearmCalls.length).toBe(2); // once at boot, once per timer tick
    expect(rearmCalls.some((i) => i > timer)).toBe(true);
  });

  // CTL-1623: the registry's "re-armable/timer" label was aspiration until this PR — no
  // caller had ever registered a hook, so armSecret("github-token") always took the
  // hookless-degrade path (secret-contract.mjs's armSecret docstring). This pins that the
  // hook registration is wired at module scope (before either call site above can fire,
  // since both live inside startDaemon()) and that the registered hook IS
  // rearmGithubTokenFromFile — not a second, parallel implementation.
  describe("rearm hook registration (CTL-1623)", () => {
    test("registerRearmHook(\"github-token\", ...) is called at module scope, not inside startDaemon", () => {
      const regLine = lineOf('registerRearmHook("github-token"');
      const startDaemonLine = lineOf("export function startDaemon({");
      expect(regLine).toBeGreaterThan(-1);
      expect(startDaemonLine).toBeGreaterThan(-1);
      expect(regLine).toBeLessThan(startDaemonLine); // registered before startDaemon is even defined
    });

    test("the registered hook closure calls rearmGithubTokenFromFile (not a duplicate implementation)", () => {
      const regLine = lineOf('registerRearmHook("github-token"');
      expect(daemonSrc[regLine]).toContain("rearmGithubTokenFromFile");
    });
  });
});
