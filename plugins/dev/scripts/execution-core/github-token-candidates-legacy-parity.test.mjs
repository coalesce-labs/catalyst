// github-token-candidates-legacy-parity.test.mjs — CTL-1623 A/B parity.
//
// githubTokenFileCandidates (github-auth-preflight.mjs) now delegates to
// lib/secret-contract.mjs's secretFileCandidates("github-token", env) instead of
// hand-rolling its own chain. This suite freezes the PRE-FOLD implementation, verbatim, as
// a test-local reference and asserts the delegate produces byte-identical candidate lists
// for every realistic env combination — and pins the ONE known, deliberate divergence
// (HOME="") separately, clearly labeled as a flagged behavior change (never smuggled as a
// no-op fold).
//
// MUST FAIL ON DIVERGENCE: every cell is toEqual against the frozen legacy output, never a
// fuzzy/partial match.
//
// Run: cd plugins/dev/scripts/execution-core && bun test github-token-candidates-legacy-parity.test.mjs

import { describe, test, expect } from "bun:test";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { githubTokenFileCandidates, rearmGithubTokenFromFile } from "./github-auth-preflight.mjs";

// ─── FROZEN LEGACY REFERENCE (verbatim copy of the pre-CTL-1623 githubTokenFileCandidates) ─
function legacyGithubTokenFileCandidates(env = process.env) {
  if (env?.CATALYST_GITHUB_TOKEN_FILE) return [env.CATALYST_GITHUB_TOKEN_FILE];
  if (env?.CATALYST_CONFIG_DIR) return [join(env.CATALYST_CONFIG_DIR, "github-token")];
  const home = env?.HOME ?? homedir();
  const layer2 = env?.CATALYST_LAYER2_CONFIG_FILE ?? join(home, ".config", "catalyst", "config.json");
  const out = [join(dirname(layer2), "github-token")];
  const xdg = join(env?.XDG_CONFIG_HOME || join(home, ".config"), "catalyst", "github-token");
  if (!out.includes(xdg)) out.push(xdg);
  return out;
}

// _cell — asserts legacy and delegate produce IDENTICAL candidate arrays for the same env.
function _cell(name, env) {
  test(name, () => {
    expect(githubTokenFileCandidates(env)).toEqual(legacyGithubTokenFileCandidates(env));
  });
}

describe("githubTokenFileCandidates vs frozen legacy chain — realistic envs (must agree)", () => {
  // (a) explicit CATALYST_GITHUB_TOKEN_FILE override — short-circuits everything else.
  _cell("(a) explicit override wins outright, even with every other var set", {
    CATALYST_GITHUB_TOKEN_FILE: "/explicit/override/path",
    CATALYST_CONFIG_DIR: "/should/be/ignored",
    HOME: "/home/x",
    XDG_CONFIG_HOME: "/xdg",
  });

  // (b) CATALYST_CONFIG_DIR explicit dir.
  _cell("(b) CATALYST_CONFIG_DIR short-circuits ahead of HOME/XDG", {
    CATALYST_CONFIG_DIR: "/cfg/dir",
    HOME: "/home/x",
    XDG_CONFIG_HOME: "/xdg",
  });

  // (c) CATALYST_LAYER2_CONFIG_FILE-derived dir.
  _cell("(c) CATALYST_LAYER2_CONFIG_FILE moves the primary candidate", {
    CATALYST_LAYER2_CONFIG_FILE: "/opt/cfg/catalyst/config.json",
    HOME: "/home/x",
  });

  // (d) default layer2 dir + XDG_CONFIG_HOME dedupe.
  _cell("(d1) same-dir dedupe: no XDG override — one candidate, not two", {
    HOME: "/home/x",
  });
  _cell("(d2) distinct XDG_CONFIG_HOME — two candidates, writer dir first", {
    HOME: "/home/x",
    XDG_CONFIG_HOME: "/xdg-distinct",
  });

  // (e) HOME set to a normal non-empty value, nothing else — the common real-world default.
  _cell("(e) HOME-only default chain", { HOME: "/home/plain" });

  // A grab-bag of realistic combinations, mirroring github-auth-preflight.test.mjs's own
  // fixtures (kept in parity here too, not just against the pre-fold function once).
  _cell("empty XDG_CONFIG_HOME is falsy-ignored on both sides", {
    HOME: "/home/x",
    XDG_CONFIG_HOME: "",
  });
  _cell("empty CATALYST_CONFIG_DIR falls through on both sides", {
    HOME: "/home/x",
    CATALYST_CONFIG_DIR: "",
  });
  _cell("empty CATALYST_GITHUB_TOKEN_FILE falls through on both sides", {
    HOME: "/home/x",
    CATALYST_GITHUB_TOKEN_FILE: "",
  });
});

// ─── FLAGGED BEHAVIOR CHANGE: HOME="" ───────────────────────────────────────────────────
//
// Legacy: `env?.HOME ?? homedir()` — `??` substitutes ONLY on null/undefined, so an
// explicit empty-string HOME is used AS-IS (home becomes "", and every downstream join()
// treats "" as a relative-path root — dirname("" + "/.config/catalyst/config.json") stays
// relative to ".", not the real home directory).
//
// Engine (secretFileCandidates / resolveLayer2Path, lib/secret-contract.mjs): explicitly
// length-checks HOME (`typeof env?.HOME === "string" && env.HOME.length > 0`) and falls
// back to homedir() for an empty string too — the saner behavior for a degenerate,
// presumably-unintentional HOME="".
//
// This is a DELIBERATE, FLAGGED divergence (CTL-1623 design note, see
// githubTokenFileCandidates's docstring) — not a bug to fix quietly, and not silently
// smuggled as "the fold is behavior-preserving". This test PINS the new (engine) behavior
// and documents exactly how it differs from the old one, so a future reviewer sees the
// change explicitly rather than rediscovering it.
describe("FLAGGED BEHAVIOR CHANGE: HOME=\"\" (CTL-1623)", () => {
  test("legacy used HOME=\"\" as-is (relative-path degenerate result)", () => {
    const legacy = legacyGithubTokenFileCandidates({ HOME: "" });
    // dirname(join("", ".config", "catalyst", "config.json")) === ".config/catalyst" — a
    // RELATIVE path, not the real home directory. Pinning the exact pre-fold shape so the
    // divergence below is provably a real behavior change, not a guess.
    expect(legacy[0]).toBe(join(".config", "catalyst", "github-token"));
    expect(legacy[0]).not.toBe(join(homedir(), ".config", "catalyst", "github-token"));
  });

  test("the engine (new behavior) falls back to homedir() for HOME=\"\", never a relative path", () => {
    const delegated = githubTokenFileCandidates({ HOME: "" });
    expect(delegated[0]).toBe(join(homedir(), ".config", "catalyst", "github-token"));
  });

  test("legacy and delegate DIVERGE for HOME=\"\" — pinned explicitly, not asserted equal", () => {
    const legacy = legacyGithubTokenFileCandidates({ HOME: "" });
    const delegated = githubTokenFileCandidates({ HOME: "" });
    expect(delegated).not.toEqual(legacy);
  });

  // A non-empty HOME (the realistic case in every production environment — a service
  // account's shell always has a real HOME) never exercises this divergence.
  test("a non-empty HOME never triggers the divergence — both agree", () => {
    const env = { HOME: "/home/real" };
    expect(githubTokenFileCandidates(env)).toEqual(legacyGithubTokenFileCandidates(env));
  });
});

// ─── SECOND FLAGGED DIVERGENCE (same root cause): CATALYST_LAYER2_CONFIG_FILE="" ────────
//
// Same `??`-vs-length-check root cause as HOME="" above, on the OTHER variable the legacy
// chain read with `??`: `env?.CATALYST_LAYER2_CONFIG_FILE ?? join(home, ...)`. An explicit
// empty string is kept as-is (dirname("") === "." — a relative path), while the engine's
// length-checked chain falls back to the default Layer-2 path. Flagged here for the same
// reason as HOME="" — an unlikely-but-possible operator misconfiguration, not smuggled as a
// behavior-preserving fold.
describe("FLAGGED BEHAVIOR CHANGE: CATALYST_LAYER2_CONFIG_FILE=\"\" (CTL-1623, same root cause as HOME=\"\")", () => {
  test("legacy used CATALYST_LAYER2_CONFIG_FILE=\"\" as-is (relative-path degenerate result)", () => {
    const legacy = legacyGithubTokenFileCandidates({ HOME: "/home/x", CATALYST_LAYER2_CONFIG_FILE: "" });
    expect(legacy[0]).toBe(join(".", "github-token"));
  });

  test("the engine falls back to the default Layer-2 dir for an empty override, never a relative path", () => {
    const delegated = githubTokenFileCandidates({ HOME: "/home/x", CATALYST_LAYER2_CONFIG_FILE: "" });
    expect(delegated[0]).toBe(join("/home/x", ".config", "catalyst", "github-token"));
  });

  test("legacy and delegate DIVERGE for CATALYST_LAYER2_CONFIG_FILE=\"\" — pinned explicitly", () => {
    const env = { HOME: "/home/x", CATALYST_LAYER2_CONFIG_FILE: "" };
    expect(githubTokenFileCandidates(env)).not.toEqual(legacyGithubTokenFileCandidates(env));
  });
});

// ─── THIRD FLAGGED DIVERGENCE (post-merge Codex round 1): malformed-file READ behavior ──
//
// Not a candidates-list divergence (githubTokenFileCandidates/secretFileCandidates never
// disagree here — this is about what rearmGithubTokenFromFile does with the BYTES it reads
// off a resolved candidate). Kept in this A/B parity file rather than a separate one since
// this file is CTL-1623's designated "JS A/B parity suite" and the divergence is the exact
// counterpart to catalyst-secret-env-legacy-parity.test.sh's (a)/(b) bash cells — the same
// underlying bug, on the JS side of the CTL-1612 pair.
//
// LEGACY (pre-fix) rearmGithubTokenFromFile read every candidate via
// `readFileSync(p, "utf8")` — decoding straight to a string, which silently REPLACES any
// invalid UTF-8 byte with U+FFFD and does NOT reject an embedded NUL (NUL is itself valid
// UTF-8, so it would have survived the strip/blank checks and been installed verbatim). The
// FIXED rearmGithubTokenFromFile reads raw bytes and applies the same containsNul /
// isValidUtf8RoundTrip parity guards lib/secret-contract.mjs's engine uses, so a malformed
// candidate now falls through (effectively "absent") instead of installing a mutated value.
describe("FLAGGED DIVERGENCE (post-merge fix): rearmGithubTokenFromFile — invalid-UTF-8 / NUL-containing candidates", () => {
  // FROZEN LEGACY REFERENCE — the pre-fix read+strip+blank-check pipeline, verbatim (minus
  // the surrounding candidate-loop/env-mutation plumbing, which is unchanged and not what
  // diverges here). Operates on a raw Buffer so it can be exercised against the SAME
  // fixture bytes the fixed implementation sees, mirroring how the bash suite freezes a
  // reference rather than re-deriving legacy behavior from prose.
  function legacyReadCandidate(buf) {
    const decoded = buf.toString("utf8"); // the bug: decodes FIRST, mangling invalid bytes
    const candidate = decoded.replace(/[\r\n]+$/, "");
    return candidate.trim() ? candidate : null; // null == "blank, falls through" (unchanged today)
  }

  test("DOCUMENTED: the legacy read pipeline would have installed the U+FFFD-mangled value for an invalid-UTF-8 file", () => {
    const buf = Buffer.from([0xff, 0xfe, 0x68, 0x69]);
    const legacyResult = legacyReadCandidate(buf);
    expect(legacyResult).not.toBeNull();
    expect(legacyResult).toContain("�");
  });

  test("FLAGGED DIVERGENCE: the fixed rearmGithubTokenFromFile fails closed instead — installs nothing, no U+FFFD", () => {
    const env = { CATALYST_GITHUB_TOKEN_FILE: "/fake/path", GITHUB_TOKEN: "good-inherited", GH_TOKEN: "good-inherited" };
    const out = rearmGithubTokenFromFile({
      env,
      readFile: () => Buffer.from([0xff, 0xfe, 0x68, 0x69]),
      log: null,
    });
    expect(out).toEqual({ rearmed: false, reason: "absent" });
    expect(env.GITHUB_TOKEN).toBe("good-inherited");
    expect(env.GITHUB_TOKEN).not.toContain("�");
  });

  test("DOCUMENTED: the legacy read pipeline would have installed the NUL-stripped mutated value for a NUL-containing file", () => {
    const buf = Buffer.from("c\0loud");
    const legacyResult = legacyReadCandidate(buf);
    // NUL survives readFileSync(...,"utf8") decoding (it is valid UTF-8) and .trim() does
    // not strip it — the legacy pipeline installs it verbatim, embedded NUL and all.
    expect(legacyResult).toBe("c\0loud");
  });

  test("FLAGGED DIVERGENCE: the fixed rearmGithubTokenFromFile rejects the NUL-containing candidate", () => {
    const env = { CATALYST_GITHUB_TOKEN_FILE: "/fake/path", GITHUB_TOKEN: "good-inherited", GH_TOKEN: "good-inherited" };
    const out = rearmGithubTokenFromFile({
      env,
      readFile: () => Buffer.from("c\0loud"),
      log: null,
    });
    expect(out).toEqual({ rearmed: false, reason: "absent" });
    expect(env.GITHUB_TOKEN).toBe("good-inherited");
  });
});
