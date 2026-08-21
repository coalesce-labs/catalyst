// agent-tools-write-path-health.test.mjs — CTL-1958 (Phase 4). Locks the CTL-2026(a)
// end state that install-agent-tools.sh produces: an out-of-tree tool that is a SYMLINK to
// the repo copy grades WRAPPER → PASS. Plus the pure classifier's verdicts, including the
// never-a-silent-clean directions.
//
// Run: cd plugins/dev/scripts/execution-core && bun test agent-tools-write-path-health
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  classifyAgentToolCopy,
  checkAgentToolsWritePath,
  repoScriptsDir,
  VERDICT,
  AGENT_TOOLS,
} from "../agent-tools-write-path-health.mjs";

describe("classifyAgentToolCopy (pure verdicts)", () => {
  const repoDir = "/repo/scripts";
  test("no out-of-tree copy → ABSENT", () => {
    expect(classifyAgentToolCopy({ name: "linear-ack.mjs", outPresent: false, repoDir }).verdict).toBe(
      VERDICT.ABSENT
    );
  });
  test("symlink resolving INTO the repo scripts dir → WRAPPER", () => {
    const r = classifyAgentToolCopy({
      name: "linear-reply.mjs",
      outPresent: true,
      linkTarget: join(repoDir, "linear-reply.mjs"),
      repoDir,
    });
    expect(r.verdict).toBe(VERDICT.WRAPPER);
  });
  test("symlink resolving OUTSIDE the repo → INCONCLUSIVE (never a silent match)", () => {
    const r = classifyAgentToolCopy({
      name: "linear-reply.mjs",
      outPresent: true,
      linkTarget: "/somewhere/else/linear-reply.mjs",
      repoDir,
    });
    expect(r.verdict).toBe(VERDICT.INCONCLUSIVE);
  });
  test("byte-identical copy → COPY_MATCHES; different digest → COPY_DRIFTED", () => {
    expect(
      classifyAgentToolCopy({ name: "x", outPresent: true, outDigest: "aa", repoDigest: "aa", repoDir }).verdict
    ).toBe(VERDICT.COPY_MATCHES);
    expect(
      classifyAgentToolCopy({ name: "x", outPresent: true, outDigest: "aa", repoDigest: "bb", repoDir }).verdict
    ).toBe(VERDICT.COPY_DRIFTED);
  });
  test("a null digest → INCONCLUSIVE, never a match", () => {
    expect(
      classifyAgentToolCopy({ name: "x", outPresent: true, outDigest: null, repoDigest: "bb", repoDir }).verdict
    ).toBe(VERDICT.INCONCLUSIVE);
  });
});

describe("checkAgentToolsWritePath over a real symlink install", () => {
  let dir;
  let outDir;
  const repoDir = repoScriptsDir();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ctl1958-doctor-"));
    outDir = join(dir, "comms", "tools");
    // mkdir -p outDir then symlink each tool → the real repo copy (what the installer does).
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    for (const name of AGENT_TOOLS) {
      symlinkSync(join(repoDir, name), join(outDir, name));
    }
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("every tool a symlink to the repo copy → PASS (WRAPPER)", () => {
    const c = checkAgentToolsWritePath({ outDir, repoDir });
    expect(c.status).toBe("pass");
    expect(c.detail).toMatch(/symlink/i);
  });

  test("a DRIFTED plain copy (not a symlink) → WARN, never PASS", () => {
    // Replace one symlink with a plain file whose bytes differ from the repo copy.
    rmSync(join(outDir, AGENT_TOOLS[0]), { force: true });
    writeFileSync(join(outDir, AGENT_TOOLS[0]), "// drifted hand-edit\n");
    const c = checkAgentToolsWritePath({ outDir, repoDir });
    expect(c.status).toBe("warn");
  });

  test("absent out-of-tree dir → PASS (nothing outside the repo to certify)", () => {
    const c = checkAgentToolsWritePath({ outDir: join(dir, "nope", "tools"), repoDir });
    expect(c.status).toBe("pass");
  });
});
