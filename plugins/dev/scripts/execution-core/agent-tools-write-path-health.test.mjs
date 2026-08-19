// CTL-2026 — the out-of-tree agent tools must be VISIBLE to doctor, and never silently pass.
//
// ⛔ THE PROPERTY UNDER TEST IS THE ABSENCE OF A FALSE CLEAN. Each case below pins the
// STATUS *and* a literal from the detail, because a check that returns the right grade with
// a detail nobody can act on is only half a check — and because pinning the grade alone
// lets a mutation that swaps two branches' messages survive.
//
// ⛔ AND THE NO-ARGS SHAPE IS TESTED. Every other case injects `readFile`/`lstat`, so the
// PRODUCTION call — `checkAgentToolsWritePath()` with no deps, which is how doctor.mjs
// invokes it — would otherwise be the one shape nothing exercises. That exact gap shipped a
// doctor check in this repo that crashed on every host behind ten green tests.
import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AGENT_TOOLS,
  VERDICT,
  checkAgentToolsWritePath,
  classifyAgentToolCopy,
  defaultOutOfTreeDir,
  repoScriptsDir,
} from "./agent-tools-write-path-health.mjs";

/** A throwaway pair of directories standing in for ~/catalyst/comms/tools + the repo. */
function fixture({ out = {}, repo = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ctl2026-doctor-"));
  const outDir = join(root, "tools");
  const repoDir = join(root, "scripts");
  mkdirSync(outDir);
  mkdirSync(repoDir);
  for (const [name, body] of Object.entries(repo)) writeFileSync(join(repoDir, name), body);
  for (const [name, body] of Object.entries(out)) {
    if (body?.symlinkTo !== undefined) symlinkSync(body.symlinkTo, join(outDir, name));
    else writeFileSync(join(outDir, name), body);
  }
  return { root, outDir, repoDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const BOTH = { "linear-reply.mjs": "reply-source", "linear-ack.mjs": "ack-source" };

describe("checkAgentToolsWritePath", () => {
  test("no out-of-tree copies at all → PASS, and it names the directory it looked in", () => {
    const f = fixture({ repo: BOTH });
    const c = checkAgentToolsWritePath({ outDir: f.outDir, repoDir: f.repoDir });
    expect(c.status).toBe("pass");
    expect(c.detail).toContain(f.outDir);
    f.cleanup();
  });

  test("byte-identical copies → WARN 'inconclusive by design', NOT pass", () => {
    const f = fixture({ out: { ...BOTH }, repo: BOTH });
    const c = checkAgentToolsWritePath({ outDir: f.outDir, repoDir: f.repoDir });
    // ⛔ THE HOLE THIS CHECK EXISTS FOR: identical bytes are NOT evidence that the
    // directory is routed — the copies cannot resolve the proxy modules from there.
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("inconclusive by design");
    f.cleanup();
  });

  test("⭐ a DRIFTED copy → WARN that says so — this is the live 2026-08-18 state", () => {
    const f = fixture({
      out: { ...BOTH, "linear-reply.mjs": "reply-source + Ryan's avatar" },
      repo: BOTH,
    });
    const c = checkAgentToolsWritePath({ outDir: f.outDir, repoDir: f.repoDir });
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("DRIFTED");
    // The drifted tool must be NAMED — "something drifted" is not actionable.
    expect(c.detail).toContain("linear-reply.mjs: DRIFTED");
    // …and the tool that did NOT drift must not be smeared with it.
    expect(c.detail).toContain("linear-ack.mjs: a byte-identical copy");
    f.cleanup();
  });

  test("symlinks into the repo → PASS (the CTL-2026(a) end state is recognised in advance)", () => {
    const f = fixture({ repo: BOTH });
    for (const n of AGENT_TOOLS) symlinkSync(join(f.repoDir, n), join(f.outDir, n));
    const c = checkAgentToolsWritePath({ outDir: f.outDir, repoDir: f.repoDir });
    expect(c.status).toBe("pass");
    expect(c.detail).toContain("symlink to the repo copy");
    f.cleanup();
  });

  test("a symlink pointing OUTSIDE the repo is INCONCLUSIVE, not a wrapper", () => {
    const f = fixture({ repo: BOTH });
    const stranger = join(f.root, "elsewhere.mjs");
    writeFileSync(stranger, "who knows");
    symlinkSync(stranger, join(f.outDir, "linear-reply.mjs"));
    const c = checkAgentToolsWritePath({ outDir: f.outDir, repoDir: f.repoDir });
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("INCONCLUSIVE");
    expect(c.detail).toContain("resolves OUTSIDE");
    f.cleanup();
  });

  test("a DANGLING symlink is inconclusive — never reported as absent", () => {
    const f = fixture({ repo: BOTH });
    symlinkSync(join(f.root, "does-not-exist.mjs"), join(f.outDir, "linear-ack.mjs"));
    const c = checkAgentToolsWritePath({ outDir: f.outDir, repoDir: f.repoDir });
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("does not resolve");
    f.cleanup();
  });

  test("⛔ an UNREADABLE file is INCONCLUSIVE — it must never read as agreement", () => {
    const f = fixture({ out: { ...BOTH }, repo: BOTH });
    const c = checkAgentToolsWritePath({
      outDir: f.outDir,
      repoDir: f.repoDir,
      readFile: (p) => {
        if (String(p).includes("tools")) throw Object.assign(new Error("nope"), { code: "EACCES" });
        return "repo";
      },
    });
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("INCONCLUSIVE");
    expect(c.detail).toContain("EACCES");
    f.cleanup();
  });

  test("a MISSING repo counterpart is inconclusive, not a match", () => {
    const f = fixture({ out: { ...BOTH } }); // repo dir exists but is empty
    const c = checkAgentToolsWritePath({ outDir: f.outDir, repoDir: f.repoDir });
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("INCONCLUSIVE");
    expect(c.detail).toContain("repo copy");
    f.cleanup();
  });

  test("INCONCLUSIVE outranks DRIFT — the louder of the two unknowns wins the grade", () => {
    const f = fixture({
      out: { "linear-reply.mjs": "drifted", "linear-ack.mjs": "ack-source" },
      repo: BOTH,
    });
    const c = checkAgentToolsWritePath({
      outDir: f.outDir,
      repoDir: f.repoDir,
      readFile: (p) => {
        if (String(p).endsWith("linear-ack.mjs"))
          throw Object.assign(new Error("x"), { code: "EIO" });
        return "differs-from-repo";
      },
    });
    expect(c.detail).toContain("INCONCLUSIVE");
    f.cleanup();
  });
});

describe("classifyAgentToolCopy — the pure core", () => {
  test("every unknown resolves to INCONCLUSIVE, never to a match", () => {
    const cases = [
      { outDigest: null, repoDigest: "a" },
      { outDigest: "a", repoDigest: null },
      { outDigest: null, repoDigest: null },
    ];
    for (const c of cases) {
      expect(classifyAgentToolCopy({ name: "x.mjs", outPresent: true, ...c }).verdict).toBe(
        VERDICT.INCONCLUSIVE
      );
    }
  });

  test("equal digests match; unequal digests drift", () => {
    const base = { name: "x.mjs", outPresent: true };
    expect(classifyAgentToolCopy({ ...base, outDigest: "a", repoDigest: "a" }).verdict).toBe(
      VERDICT.COPY_MATCHES
    );
    expect(classifyAgentToolCopy({ ...base, outDigest: "a", repoDigest: "b" }).verdict).toBe(
      VERDICT.COPY_DRIFTED
    );
  });
});

describe("the production shape — no deps injected", () => {
  // ⛔ This is the call doctor.mjs actually makes. Everything above drives seams; if the
  // defaults are wrong (a bad path join, a missing import, a throw on a host with no
  // ~/catalyst) none of it would notice.
  test("checkAgentToolsWritePath() runs with no arguments and returns a well-formed row", () => {
    const c = checkAgentToolsWritePath();
    expect(c.name).toBe("agent-tools-write-path");
    expect(["pass", "warn", "fail", "info"]).toContain(c.status);
    expect(typeof c.detail).toBe("string");
    expect(c.detail.length).toBeGreaterThan(0);
    // ⛔ Never FAIL: doctor's FAIL count gates worker activation and this is advisory.
    expect(c.status).not.toBe("fail");
  });

  test("the default paths resolve to real, distinct locations", () => {
    expect(defaultOutOfTreeDir({ HOME: "/home/x" })).toBe("/home/x/catalyst/comms/tools");
    expect(defaultOutOfTreeDir({ CATALYST_DIR: "/srv/cat", HOME: "/home/x" })).toBe(
      "/srv/cat/comms/tools"
    );
    // repoScriptsDir must point at the directory that actually holds the tools.
    expect(repoScriptsDir().endsWith("/plugins/dev/scripts")).toBe(true);
  });
});
