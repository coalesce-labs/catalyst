// CTL-2026 — the agent tools must survive being the ONLY file in their directory.
//
// ⛔ WHAT THIS PINS, AND WHY A UNIT TEST OF decideWritePath CANNOT PIN IT.
// `linear-ack.mjs` and `linear-reply.mjs` guard their `./execution-core/*` imports in a
// try/catch whose own comment says the guard exists because an out-of-tree copy cannot
// resolve them. Both then imported `./lib/linear-write-path.mjs` — the leaf that decides
// what to do about that very failure — on a line OUTSIDE the try. A copy with no sibling
// directories therefore died with an unhandled ERR_MODULE_NOT_FOUND before reaching the
// branch written for it. `decideWritePath`'s own suite is green in both worlds, because
// the defect is not in the decision; it is in whether the decision is reachable.
//
// `~/catalyst/comms/tools/` is exactly that shape — a flat directory holding copies of
// these two files, invoked by every lane's brief — and CTL-2026(b)'s announced sync step
// is the thing that would have put the current file there. So this suite reproduces that
// deployment literally: copy the tool alone into an empty directory and RUN it.
//
// ⛔ THE NETWORK IS STUBBED AT `globalThis.fetch` VIA `node --import`, NOT MOCKED IN-PROCESS.
// These scripts are top-level-await side-effect programs: importing one performs the write.
// The only way to observe their behaviour is to execute them, and the only way to execute
// them hermetically is to replace fetch in the child before the module graph loads.
//
// ⛔ NEITHER THE EXIT CODE NOR THE MODULE-ERROR TEXT DISCRIMINATES. Two traps, both hit
// while writing this file, both recorded because the obvious assertion is wrong twice over:
//
//  1. The pre-fix CRASH and the correct enforce-mode REFUSAL BOTH exit 1.
//  2. `Cannot find module` appears in the crash AND in the healthy degraded run — the
//     resolution failure is the very `unavailableReason` the fixed tool prints on purpose.
//     And the node-only spelling `ERR_MODULE_NOT_FOUND` does not appear under bun AT ALL
//     (measured: bun 1.3.5 prints `error: Cannot find module '<spec>' from '<file>'`, zero
//     occurrences of the code), so an assertion phrased against it is INERT under the very
//     runner CI uses — a guard that cannot fail, in the guard for a guard that could not fire.
//
// So every assertion below is POSITIVE and pinned to a literal only the TOOL'S OWN CODE can
// emit: its JSON on stdout, or its `linear-*: ` prefixed message on stderr. A crash produces
// neither, whatever it is spelled like and whatever it exits with.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, copyFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS = dirname(fileURLToPath(new URL("../linear-ack.mjs", import.meta.url)));
/**
 * ⛔ INERT STAND-INS FOR THE CREDENTIALS linear-reply.mjs GATES ON, AND WHY THEY ARE HERE.
 * That tool exits 2 when LINEAR_SYNC_CLIENT_ID/SECRET are unset — BEFORE it reaches any of
 * the behaviour under test. Those are exported in a developer's shell and absent on CI, so
 * the first cut of this suite was 7/7 locally and 2 pass / 5 fail on the Linux runner:
 * every linear-reply case failed with exit 2 while every linear-ack case passed (that tool
 * has no such gate). It was measuring the machine, not the code — the "a test driven
 * through the ambient environment is a test of the environment" trap, already on this
 * repo's record and repeated here.
 *
 * Reproduce the CI failure locally with:
 *   env -u LINEAR_SYNC_CLIENT_ID -u LINEAR_SYNC_CLIENT_SECRET bun test agent-tools-out-of-tree.test.mjs
 *
 * The values are never used: `fetch` is stubbed in the child, so nothing is minted or sent.
 */
const STUB_CREDS = Object.freeze({
  LINEAR_SYNC_CLIENT_ID: "stub-client-id",
  LINEAR_SYNC_CLIENT_SECRET: "stub-client-secret",
});
const HUMAN = "c2a8cc92-cab6-4536-9500-0f24abdf702b";

/** A fetch stub covering every call these two tools make: the OAuth mint, the issue
 *  read, and each mutation. Returns success everywhere, so any non-zero exit or absent
 *  output is the TOOL's doing and not the transport's. */
const STUB = `
const HUMAN = ${JSON.stringify(HUMAN)};
const comment = { id: "c1", createdAt: "2026-08-18T00:00:00.000Z", parent: null,
  user: { id: HUMAN, name: "Ryan" }, botActor: null,
  reactions: [{ id: "rx1", emoji: "eyes", user: { id: HUMAN } }] };
globalThis.fetch = async (url, opts) => {
  if (String(url).includes("/oauth/token")) return { json: async () => ({ access_token: "stub-token" }) };
  const q = JSON.parse(opts.body).query;
  if (q.includes("commentCreate")) return { json: async () => ({ data: { commentCreate: { success: true, comment: { id: "new1", url: "https://linear.app/x" } } } }) };
  if (q.includes("reactionCreate")) return { json: async () => ({ data: { reactionCreate: { success: true, reaction: { id: "r2" } } } }) };
  if (q.includes("reactionDelete")) return { json: async () => ({ data: { reactionDelete: { success: true } } }) };
  return { json: async () => ({ data: { issue: { id: "i1", url: "https://linear.app/i1", comments: { nodes: [comment] } } } }) };
};
`;

let dir;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "ctl2026-"));
  writeFileSync(join(dir, "stub.mjs"), STUB);
  for (const f of ["linear-ack.mjs", "linear-reply.mjs"])
    copyFileSync(join(SCRIPTS, f), join(dir, f));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Run one tool as the ONLY file in `dir` (plus the stub). No sibling lib/ or
 *  execution-core/ — the deployment shape of ~/catalyst/comms/tools/. */
function runIsolated(tool, args, env = {}) {
  const r = spawnSync(process.execPath, ["--import", "./stub.mjs", tool, ...args], {
    cwd: dir,
    encoding: "utf8",
    // Strip an ambient mode, and PIN the credentials, so neither the developer's shell nor
    // CI's lack of one can decide the verdict. See STUB_CREDS.
    env: { ...process.env, ...STUB_CREDS, CATALYST_LINEAR_WRITE_PROXY: undefined, ...env },
  });
  // ⛔ bun COLOURS child stderr, so a raw `startsWith`/`grep` against it silently matches
  // nothing — the repo's standing ANSI trap, which here would have read as "the tool said
  // nothing" instead of "I could not see what it said".
  return { code: r.status, out: strip(r.stdout ?? ""), err: strip(r.stderr ?? "") };
}

/** Remove SGR sequences so assertions see the text, not the colouring. */
function strip(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, "");
}

describe("the tools run when they are the only file in the directory (CTL-2026)", () => {
  test("⛔ THE DEFECT: each tool reaches its own code and completes its write", () => {
    for (const [tool, args] of [
      ["linear-ack.mjs", ["CTL-1"]],
      ["linear-reply.mjs", ["CTL-1", "--as", "CTL", "--body", "probe"]],
    ]) {
      const r = runIsolated(tool, args);
      // A resolution crash exits non-zero with an EMPTY stdout, on both runtimes. Asserting
      // the tool's own JSON is present is therefore the discriminator, and it is positive:
      // it cannot be satisfied by a process that died before running the tool's body.
      expect(`${tool} exit ${r.code} out=${JSON.stringify(r.out)}`).toBe(
        `${tool} exit 0 out=${JSON.stringify(r.out)}`
      );
      expect(() => JSON.parse(r.out.trim())).not.toThrow();
      expect(r.err).toContain(`${tool.replace(".mjs", "")}: `);
    }
  });

  test("linear-ack still performs its reaction, and says WHY it went direct", () => {
    const r = runIsolated("linear-ack.mjs", ["CTL-1"]);
    expect(JSON.parse(r.out.trim())).toEqual({
      via: "direct",
      ok: true,
      commentId: "c1",
      emoji: "eyes",
    });
    // The reason must survive to the operator — degrading silently is the failure class.
    expect(r.err).toContain("proxy modules unreachable");
    // ⛔ and it must NOT claim the mode is `off`: without the modules it cannot read
    // Layer-2, so an absent env var is "could not confirm", not "not configured".
    expect(r.err).toContain("UNCONFIRMED");
  });

  test("linear-reply still posts the reply AND clears the 👀 direct", () => {
    const r = runIsolated("linear-reply.mjs", ["CTL-1", "--as", "CTL", "--body", "probe"]);
    expect(JSON.parse(r.out.trim())).toEqual({
      ok: true,
      commentId: "new1",
      parentId: "c1",
      url: "https://linear.app/x",
      eyesCleared: 1,
    });
  });

  test("under enforce, linear-ack REFUSES rather than writing direct — and says so, not just exit 1", () => {
    const r = runIsolated("linear-ack.mjs", ["CTL-1"], { CATALYST_LINEAR_WRITE_PROXY: "enforce" });
    expect(r.code).toBe(1);
    // ⛔ The pre-fix CRASH also exited 1, and it also mentions the module. The ONLY thing
    // that separates them is this literal, which only linear-ack itself can print.
    expect(r.err).toContain("linear-ack: REFUSED — mode=enforce");
    expect(r.out).toBe("");
  });

  test("under enforce, linear-reply still POSTS (the clear is best-effort) and reports the skip", () => {
    const r = runIsolated("linear-reply.mjs", ["CTL-1", "--as", "CTL", "--body", "probe"], {
      CATALYST_LINEAR_WRITE_PROXY: "enforce",
    });
    // ⛔ A reply that succeeded must never report failure: the caller could retry into a
    // double-posted comment. Refusing the CLEAN-UP must not fail the thing cleaned up after.
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out.trim()).ok).toBe(true);
    expect(JSON.parse(r.out.trim()).eyesCleared).toBe(0);
    expect(r.err).toContain("👀 NOT cleared");
  });
});

describe("linear-reply --body file-path guard (CTL-2127)", () => {
  test("an EXISTING file path is auto-read and its CONTENT is posted, not the path", () => {
    const fileContent = "# Real content\n\nline two\n";
    writeFileSync(join(dir, "body.md"), fileContent);
    const capture = `
${STUB.replaceAll("`", "\\`")}
const inner = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  let b = {};
  try { b = opts?.body ? JSON.parse(opts.body) : {}; } catch { b = {}; }
  if (typeof b.query === "string" && b.query.includes("commentCreate")) {
    console.error("CAPTURED_INPUT " + JSON.stringify(b.variables.in));
  }
  return inner(url, opts);
};
`;
    writeFileSync(join(dir, "capture-2127.mjs"), capture);
    const r = spawnSync(
      process.execPath,
      ["--import", "./capture-2127.mjs", "linear-reply.mjs", "CTL-1", "--as", "CTL", "--body", "./body.md"],
      {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, ...STUB_CREDS, CATALYST_LINEAR_WRITE_PROXY: undefined },
      }
    );
    const stripped = strip(r.stderr ?? "");
    const line = stripped.split("\n").find((l) => l.startsWith("CAPTURED_INPUT "));
    expect(line).toBeTruthy();
    const input = JSON.parse(line.slice("CAPTURED_INPUT ".length));
    // The body must be the FILE CONTENT, not the path string
    expect(input.body).toBe(fileContent);
    expect(r.status).toBe(0);
    // The guard must announce what it did — non-silent
    expect(stripped).toContain("linear-reply:");
  });

  test("a path-like value that is NOT a readable file is REFUSED, nothing posted", () => {
    const r = runIsolated("linear-reply.mjs", [
      "CTL-1", "--as", "CTL", "--body", "/tmp/does-not-exist-ctl2127-xyz.md",
    ]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("linear-reply:");
    expect(r.err).toMatch(/file path|--body -/);
    // No commentCreate JSON on stdout => nothing was posted
    expect(r.out).toBe("");
  });

  test("a normal multi-word body still posts verbatim (no false positive)", () => {
    const r = runIsolated("linear-reply.mjs", [
      "CTL-1", "--as", "CTL", "--body", "See the notes.md file for details",
    ]);
    expect(JSON.parse(r.out.trim()).ok).toBe(true);
  });

  test("--body - (stdin) is unaffected by the guard", () => {
    const stdinContent = "Content piped from stdin\n";
    const capture = `
${STUB.replaceAll("`", "\\`")}
const inner = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  let b = {};
  try { b = opts?.body ? JSON.parse(opts.body) : {}; } catch { b = {}; }
  if (typeof b.query === "string" && b.query.includes("commentCreate")) {
    console.error("CAPTURED_INPUT " + JSON.stringify(b.variables.in));
  }
  return inner(url, opts);
};
`;
    writeFileSync(join(dir, "capture-stdin-2127.mjs"), capture);
    const r = spawnSync(
      process.execPath,
      ["--import", "./capture-stdin-2127.mjs", "linear-reply.mjs", "CTL-1", "--as", "CTL", "--body", "-"],
      {
        cwd: dir,
        encoding: "utf8",
        input: stdinContent,
        env: { ...process.env, ...STUB_CREDS, CATALYST_LINEAR_WRITE_PROXY: undefined },
      }
    );
    const stripped = strip(r.stderr ?? "");
    const line = stripped.split("\n").find((l) => l.startsWith("CAPTURED_INPUT "));
    expect(line).toBeTruthy();
    const input = JSON.parse(line.slice("CAPTURED_INPUT ".length));
    expect(input.body).toBe(stdinContent);
    expect(r.status).toBe(0);
  });
});

describe("the avatar Ryan added out-of-tree is in the repo copy (CTL-2026)", () => {
  // ⭐ THE MEASUREMENT BEHIND THIS: CTL-2026 was filed on "they are true copies,
  // byte-identical". Six hours later Ryan hand-edited ONLY the out-of-tree
  // linear-reply.mjs (2026-08-18 19:46:30) to add a per-agent avatar. Option (a) — make
  // the out-of-tree file a wrapper that execs the repo copy — would then have silently
  // deleted the avatars on every lane's next reply. This asserts the repo copy actually
  // sends the field, by reading it off the WIRE rather than grepping the source: a grep
  // would pass on a declared-but-unused constant, which is the same class of untruth.
  test("commentCreate carries displayIconUrl, derived from --as", () => {
    const capture = `
${STUB}
const inner = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  // ⛔ The OAuth mint's body is a URLSearchParams, not JSON — an unguarded JSON.parse here
  // throws inside the stub, the mint fails, and the tool dies for a reason that has nothing
  // to do with what is being measured. (It did, on the first run of this suite.)
  let b = {};
  try { b = opts?.body ? JSON.parse(opts.body) : {}; } catch { b = {}; }
  if (typeof b.query === "string" && b.query.includes("commentCreate")) {
    console.error("CAPTURED_INPUT " + JSON.stringify(b.variables.in));
  }
  return inner(url, opts);
};
`;
    writeFileSync(join(dir, "capture.mjs"), capture);
    const r = spawnSync(
      process.execPath,
      [
        "--import",
        "./capture.mjs",
        "linear-reply.mjs",
        "CTL-1",
        "--as",
        "FLEET",
        "--body",
        "probe",
      ],
      {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, ...STUB_CREDS, CATALYST_LINEAR_WRITE_PROXY: undefined },
      }
    );
    const line = strip(r.stderr ?? "")
      .split("\n")
      .find((l) => l.startsWith("CAPTURED_INPUT "));
    expect(line).toBeTruthy();
    const input = JSON.parse(line.slice("CAPTURED_INPUT ".length));
    expect(input.createAsUser).toBe("FLEET");
    // Deterministic from the agent tag: the same agent always renders the same image.
    expect(input.displayIconUrl).toBe("https://api.dicebear.com/9.x/shapes/svg?seed=fleet");
  });

  test("CATALYST_AVATAR_URL_TEMPLATE overrides the generator, and {slug} is the agent tag", () => {
    const r = spawnSync(
      process.execPath,
      [
        "--import",
        "./capture.mjs",
        "linear-reply.mjs",
        "CTL-1",
        "--as",
        "CTL-INSTALL",
        "--body",
        "probe",
      ],
      {
        cwd: dir,
        encoding: "utf8",
        env: {
          ...process.env,
          ...STUB_CREDS,
          CATALYST_LINEAR_WRITE_PROXY: undefined,
          CATALYST_AVATAR_URL_TEMPLATE: "https://example.invalid/{slug}.png",
        },
      }
    );
    const line = strip(r.stderr ?? "")
      .split("\n")
      .find((l) => l.startsWith("CAPTURED_INPUT "));
    expect(line).toBeTruthy();
    const input = JSON.parse(line.slice("CAPTURED_INPUT ".length));
    expect(input.displayIconUrl).toBe("https://example.invalid/ctl-install.png");
  });
});
