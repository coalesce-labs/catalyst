// session-recency.test.mjs — lastSeenMsForSession unit tests (CTL-649).
// Drives the helper against a temp projectsDir so no real ~/.claude is touched.

import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lastSeenMsForSession } from "./session-recency.mjs";

let root;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
});

// Lay out a fake projects dir: <root>/<project>/<sessionId>.jsonl
function makeProjectsDir() {
  root = mkdtempSync(join(tmpdir(), "ctl649-recency-"));
  return root;
}

function writeTranscript(projectsDir, project, sessionId, { mtimeEpochS } = {}) {
  const projDir = join(projectsDir, project);
  mkdirSync(projDir, { recursive: true });
  const file = join(projDir, `${sessionId}.jsonl`);
  writeFileSync(file, '{"type":"turn"}\n');
  if (mtimeEpochS != null) utimesSync(file, mtimeEpochS, mtimeEpochS);
  return file;
}

describe("lastSeenMsForSession", () => {
  it("returns ~ (now - mtime) for an existing transcript", () => {
    const projectsDir = makeProjectsDir();
    const sessionId = "abc12345-aaaa-bbbb-cccc-dddddddddddd";
    const nowS = 1_700_000_000;
    const mtimeS = nowS - 300; // touched 5 min ago
    writeTranscript(projectsDir, "-Users-ryan-proj", sessionId, { mtimeEpochS: mtimeS });
    const ms = lastSeenMsForSession(sessionId, {
      now: nowS * 1000,
      projectsDir,
    });
    // utimes truncates to whole seconds; allow a small tolerance.
    expect(ms).toBeGreaterThanOrEqual(299_000);
    expect(ms).toBeLessThanOrEqual(301_000);
  });

  it("returns null for a missing session", () => {
    const projectsDir = makeProjectsDir();
    writeTranscript(projectsDir, "-Users-ryan-proj", "11111111-aaaa-bbbb-cccc-dddddddddddd");
    const ms = lastSeenMsForSession("99999999-aaaa-bbbb-cccc-dddddddddddd", {
      now: Date.now(),
      projectsDir,
    });
    expect(ms).toBeNull();
  });

  it("returns null when the projects dir does not exist", () => {
    const ms = lastSeenMsForSession("abc12345-aaaa-bbbb-cccc-dddddddddddd", {
      now: Date.now(),
      projectsDir: "/no/such/projects/dir",
    });
    expect(ms).toBeNull();
  });

  it("returns null for a null/empty sessionId", () => {
    const projectsDir = makeProjectsDir();
    expect(lastSeenMsForSession(null, { projectsDir })).toBeNull();
    expect(lastSeenMsForSession("", { projectsDir })).toBeNull();
  });

  it("scans multiple project subdirs to find the transcript", () => {
    const projectsDir = makeProjectsDir();
    // Decoy project dirs with unrelated transcripts.
    writeTranscript(projectsDir, "-Users-ryan-projA", "aaaaaaaa-aaaa-bbbb-cccc-dddddddddddd");
    writeTranscript(projectsDir, "-Users-ryan-projB", "bbbbbbbb-aaaa-bbbb-cccc-dddddddddddd");
    const sessionId = "cccccccc-aaaa-bbbb-cccc-dddddddddddd";
    const nowS = 1_700_000_000;
    writeTranscript(projectsDir, "-Users-ryan-projC", sessionId, { mtimeEpochS: nowS - 10 });
    const ms = lastSeenMsForSession(sessionId, {
      now: nowS * 1000,
      projectsDir,
    });
    expect(ms).toBeGreaterThanOrEqual(9_000);
    expect(ms).toBeLessThanOrEqual(11_000);
  });
});
