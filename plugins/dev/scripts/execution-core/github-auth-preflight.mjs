// github-auth-preflight.mjs — CTL-1612. Daemon-boot GitHub credential preflight.
//
// WHY THIS EXISTS. A daemon captures its GitHub credential at process start and never
// re-reads it, so a revoked credential is invisible from inside the daemon: every `gh`
// API call simply 401s forever. On 2026-08-02 both minis booted holding a revoked token
// and produced 102 authentication failures over 5+ hours with NO operator-visible signal
// — the only trace was a repeated warning line in daemon.log. This module turns that
// silent, indefinite failure into ONE loud alert at boot.
//
// POSTURE: strictly ADVISORY. It never throws, never blocks boot, and never gates
// dispatch. A daemon with a bad credential still starts (plenty of its work needs no
// GitHub at all) — it just says so.
//
// THE THREE-STATE RESULT IS LOAD-BEARING. "Could not prove the credential is good" is NOT
// the same as "the credential is bad". A DNS blip, a GitHub 5xx, a missing `gh` binary, or
// the probe timeout must stay SILENT; only a definitive 401 alerts. Collapsing these into
// a boolean would page the whole fleet on any transient network hiccup.
//
// Run: cd plugins/dev/scripts/execution-core && bun test github-auth-preflight.test.mjs
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { log as defaultLog } from "./config.mjs";
import { emitGithubAuthUnusable } from "./dispatch-alert.mjs";
import { secretFileCandidates } from "../lib/secret-contract.mjs"; // CTL-1623: the github-token row's candidate chain, single-sourced from the registry

// Bounded so a hung/unreachable api.github.com can never wedge daemon boot.
export const GITHUB_PROBE_TIMEOUT_MS = 10_000;

// isUnauthorizedOutput — a DEFINITIVE credential rejection, as `gh` reports it.
// `gh api` on a bad token writes e.g. `gh: Bad credentials (HTTP 401)` to stderr.
// Deliberately narrow: anything not matched here is treated as transient/unknown and
// stays silent. A 403 is NOT included — that is a scope/rate problem, not a dead
// credential, and it must not fire the "replace your credential" alert.
export function isUnauthorizedOutput(text) {
  const s = String(text ?? "");
  return /\bHTTP 401\b/i.test(s) || /\bbad credentials\b/i.test(s);
}

// defaultProbeGithubAuth — one bounded, read-only probe. NEVER throws.
// `/rate_limit` is the cheapest authenticated endpoint: it does not count against the
// rate limit it reports, so a restart loop cannot burn quota.
//
// `env` is threaded explicitly all the way into spawnSync so tests can inject a
// credential-bearing environment without touching process.env. It must carry a PATH or
// `gh` will not resolve.
export function defaultProbeGithubAuth(env = process.env) {
  try {
    const r = spawnSync("gh", ["api", "/rate_limit", "--silent"], {
      encoding: "utf8",
      env,
      timeout: GITHUB_PROBE_TIMEOUT_MS,
    });
    if (r.error) {
      // ENOENT (no gh on PATH), ETIMEDOUT, spawn failure → unknown, never an alert.
      return { ok: false, unauthorized: false, transient: true, reason: r.error.message };
    }
    if (r.status === 0) return { ok: true, unauthorized: false, transient: false, reason: null };
    const combined = `${r.stderr ?? ""}\n${r.stdout ?? ""}`;
    if (isUnauthorizedOutput(combined)) {
      return { ok: false, unauthorized: true, transient: false, reason: "HTTP 401" };
    }
    return {
      ok: false,
      unauthorized: false,
      transient: true,
      reason: `gh exited ${r.status}`,
    };
  } catch (err) {
    return { ok: false, unauthorized: false, transient: true, reason: err?.message ?? String(err) };
  }
}

// githubTokenFileCandidates — the resolution CHAIN, in priority order. CTL-1623: delegates
// to the shared secret contract (lib/secret-contract.mjs's secretFileCandidates) instead of
// hand-rolling a second copy of the chain — this function and
// lib/catalyst-secret-env.sh's catalyst_project_github_token were the last CTL-1612 pair
// still reading it by hand; the engine is now the single source for both.
//
// The writers disagree (Codex P1, round 2): cluster-sync materializes bare secrets into
// dirname(getLayer2ConfigPath()), whose default is HARDCODED ~/.config/catalyst and is
// NOT XDG-aware, while other tooling (setup-webhooks.sh:23, lib/linear-app-actor.sh:30)
// IS. Reading only the XDG path would miss every rotation on an XDG host — strictly worse
// than the hardcoded read. So prefer cluster-sync's own destination, then fall back to
// the XDG location, and take the first readable non-empty file. See
// secretFileCandidates/explicitFileOverrideEnvName in lib/secret-contract.mjs for the exact
// chain (explicit CATALYST_GITHUB_TOKEN_FILE override → CATALYST_CONFIG_DIR →
// cluster-sync's own destination dir → XDG dir).
//
// ONE FLAGGED BEHAVIOR CHANGE (CTL-1623, HOME=""): the pre-fold chain used
// `env?.HOME ?? homedir()`, which only substitutes on HOME being null/undefined — an
// explicit empty-string HOME was used as-is (dirname("" + "/.config/...") stays relative to
// "."). The engine's chain length-checks HOME (`typeof env?.HOME === "string" &&
// env.HOME.length > 0`) and falls back to homedir() for an empty string too — the saner
// behavior for a degenerate, presumably-unintentional HOME="". See
// github-auth-preflight.test.mjs's "HOME=''" cell for the pinned before/after.
export function githubTokenFileCandidates(env = process.env) {
  return secretFileCandidates("github-token", env);
}

// defaultGithubTokenFile — the highest-priority candidate (cluster-sync's destination).
export function defaultGithubTokenFile(env = process.env) {
  return githubTokenFileCandidates(env)[0];
}

// rearmGithubTokenFromFile — CTL-1612 (Codex P1). Re-read the shared credential from
// disk and update this process's env if it has changed.
//
// WHY THIS IS NEEDED even though the launcher already projected the file: a node that
// was OFFLINE during a rotation boots with the stale local copy, and only afterwards does
// daemon boot run clusterSync() — which pulls and materializes the replacement onto disk.
// Nothing re-reads it, and because the boot sync seeds the change-detection marker at the
// new HEAD, the periodic refresh then reports "head-unchanged" and never fires
// restart-required. Without this the daemon 401s until a SECOND, manual restart — the
// exact silent-stale shape this ticket exists to close, just one layer deeper.
//
// Call AFTER clusterSync. Respects an explicit operator override (the launcher marks it
// CATALYST_GITHUB_TOKEN_SOURCE=operator-override) and never throws.
export function rearmGithubTokenFromFile({
  env = process.env,
  readFile = (p) => readFileSync(p, "utf8"),
  log = defaultLog,
} = {}) {
  try {
    if (env?.CATALYST_GITHUB_TOKEN_SOURCE === "operator-override") {
      return { rearmed: false, reason: "operator-override" };
    }
    let tok = "";
    let found = false;
    for (const file of githubTokenFileCandidates(env)) {
      let raw;
      try {
        raw = readFile(file);
      } catch {
        continue; // not on this host — try the next candidate
      }
      found = true;
      // Strip ONLY trailing line terminators; preserve every other byte.
      // `.replace(/\s+/g,"")` corrupted internal whitespace, and a full `.trim()` corrupts
      // SIGNIFICANT BOUNDARY whitespace — both produce a different credential that looks
      // present and is silently wrong. ALL trailing terminators, not just the last one:
      // the bash launcher reads via `$(cat …)`, which eats every trailing newline, so a
      // file ending in `\n\n` must re-arm to the same bare token the launcher installed.
      // Mirrors _catalyst_strip_eol in lib/catalyst-secret-env.sh so the bash and JS
      // readers cannot disagree.
      const candidate = String(raw ?? "").replace(/[\r\n]+$/, "");
      // Blank-check, not truthiness: a whitespace-only file must keep falling through to
      // the next candidate (a truthy "   " would break here and mask a valid fallback).
      if (candidate.trim()) {
        tok = candidate;
        break;
      }
    }
    if (!found) return { rearmed: false, reason: "absent" }; // no shared file anywhere
    // Never install an empty value: "" reads as SET to `??`/`${X:-}` and would defeat
    // gh's hosts.yml/keyring fallback for hosts that rely on it.
    // Blank-check WITHOUT mutating: a whitespace-only file counts as absent (never install
    // "", which reads as SET to `??` and would defeat gh's hosts.yml/keyring fallback),
    // while a value with significant boundary whitespace is installed byte-for-byte.
    if (!tok.trim()) return { rearmed: false, reason: "empty" };
    if (tok === env.GITHUB_TOKEN && tok === env.GH_TOKEN) {
      return { rearmed: false, reason: "unchanged" };
    }
    env.GITHUB_TOKEN = tok;
    env.GH_TOKEN = tok; // both, because `gh` resolves GH_TOKEN first
    env.CATALYST_GITHUB_TOKEN_SOURCE = "shared-file-resynced";
    log?.warn?.(
      {},
      "github-auth-preflight: the shared GitHub credential changed on disk after launch " +
        "(cluster-sync materialized a rotation) — re-armed in-process, no restart needed",
    );
    return { rearmed: true, reason: "rotated" };
  } catch (err) {
    log?.warn?.({ err: err?.message }, "github-auth-preflight: re-arm failed (continuing)");
    return { rearmed: false, reason: "error" };
  }
}

// resolveGithubBootAuth — the daemon-boot entrypoint. Returns a small verdict object
// for logging/testing; the caller ignores it. NEVER throws.
//
// Emits the alert on `unauthorized` ONLY. The credential's provenance breadcrumb
// (CATALYST_GITHUB_TOKEN_SOURCE, exported by catalyst-execution-core's
// _project_shared_github_token) rides along so an operator can tell at a glance whether
// the daemon was running the shared SOPS file, an inherited value, or nothing at all —
// which is precisely the distinction that took hours to establish during the outage.
export function resolveGithubBootAuth({
  env = process.env,
  probe = defaultProbeGithubAuth,
  emitAlert = emitGithubAuthUnusable,
  log = defaultLog,
  rearm = rearmGithubTokenFromFile,
} = {}) {
  // CTL-1612 (Codex P1): pick up a rotation that cluster-sync materialized AFTER the
  // launcher projected the file, so we probe the credential we will actually use.
  try {
    rearm({ env, log });
  } catch (err) {
    log?.warn?.({ err: err?.message }, "github-auth-preflight: re-arm threw (continuing)");
  }
  const tokenSource = env?.CATALYST_GITHUB_TOKEN_SOURCE ?? "unknown";
  let result;
  try {
    result = probe(env);
  } catch (err) {
    // A throwing injected probe must not take the daemon down with it.
    log?.warn?.(
      { err: err?.message },
      "github-auth-preflight: probe threw — skipping (advisory only)",
    );
    return { checked: false, ok: false, unauthorized: false, tokenSource };
  }

  if (result?.ok) {
    log?.debug?.({ tokenSource }, "github-auth-preflight: GitHub credential accepted");
    return { checked: true, ok: true, unauthorized: false, tokenSource };
  }

  if (result?.unauthorized === true) {
    log?.error?.(
      { tokenSource },
      "github-auth-preflight: GitHub credential REJECTED (401) — every gh API call from " +
        "this daemon and its workers will fail until it is replaced and the daemon restarted",
    );
    try {
      emitAlert({ tokenSource, reason: result?.reason ?? undefined });
    } catch (err) {
      log?.warn?.({ err: err?.message }, "github-auth-preflight: alert emit failed (continuing)");
    }
    return { checked: true, ok: false, unauthorized: true, tokenSource };
  }

  // Transient/unknown → log quietly and stay silent. Not proof of a bad credential.
  log?.warn?.(
    { tokenSource, reason: result?.reason ?? null },
    "github-auth-preflight: could not verify the GitHub credential (transient) — no alert",
  );
  return { checked: true, ok: false, unauthorized: false, tokenSource };
}
