// transcript-silence.test.mjs — CTL-729 Phase 2 tests.
// All fs/clock/resolver injected; never touches real ~/.claude.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transcriptAgeMs, resolveTranscriptPath, slugFor } from "./transcript-silence.mjs";

const PROJ = "-fake-wt-CTL-729";
const SID = "afae16b9-488f-4553-b996-85611ae9ecef";
const SHORT = "afae16b9";

// stub resolver: only maps SHORT → SID
const resolver = (bg) => (bg === SHORT ? SID : null);

const setMtime = (p, sec) => utimesSync(p, sec, sec); // utimesSync takes seconds

let ROOT;
beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), "ctl729-silence-"));
  mkdirSync(join(ROOT, "projects", PROJ), { recursive: true });
});
afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe("transcriptAgeMs", () => {
  test("parent-only: age = now − parent mtime", () => {
    const f = join(ROOT, "projects", PROJ, `${SID}.jsonl`);
    writeFileSync(f, "{}\n");
    setMtime(f, 1000); // mtime = 1000s = 1_000_000ms
    expect(
      transcriptAgeMs(
        { bgJobId: SHORT },
        { now: 1_060_000, projectsRoot: join(ROOT, "projects"), resolveSession: resolver },
      ),
    ).toBe(60_000);
  });

  test("fresh subagent overrides stale parent → NOT silent (Gherkin 3)", () => {
    const parent = join(ROOT, "projects", PROJ, `${SID}.jsonl`);
    writeFileSync(parent, "{}\n");
    setMtime(parent, 1000);
    const subDir = join(ROOT, "projects", PROJ, SID, "subagents");
    mkdirSync(subDir, { recursive: true });
    const sub = join(subDir, "child-1.jsonl");
    writeFileSync(sub, "{}\n");
    setMtime(sub, 1058); // 1058s = 1_058_000ms, 2s before now=1_060_000
    expect(
      transcriptAgeMs(
        { bgJobId: SHORT },
        { now: 1_060_000, projectsRoot: join(ROOT, "projects"), resolveSession: resolver },
      ),
    ).toBe(2_000);
  });

  test("null bgJobId → null", () => {
    expect(transcriptAgeMs({ bgJobId: null }, { now: 1, resolveSession: resolver })).toBeNull();
  });

  test("resolver miss → null", () => {
    expect(
      transcriptAgeMs(
        { bgJobId: "deadbeef" },
        { now: 1, projectsRoot: join(ROOT, "projects"), resolveSession: resolver },
      ),
    ).toBeNull();
  });

  test("session resolves but no transcript file → null", () => {
    expect(
      transcriptAgeMs(
        { bgJobId: SHORT },
        { now: 1, projectsRoot: join(ROOT, "projects"), resolveSession: resolver },
      ),
    ).toBeNull();
  });

  test("non-.jsonl noise in subagents dir is ignored (parent age used)", () => {
    const parent = join(ROOT, "projects", PROJ, `${SID}.jsonl`);
    writeFileSync(parent, "{}\n");
    setMtime(parent, 1000);
    const subDir = join(ROOT, "projects", PROJ, SID, "subagents");
    mkdirSync(subDir, { recursive: true });
    // a non-.jsonl file with fresh mtime should NOT affect the result
    const lock = join(subDir, "index.lock");
    writeFileSync(lock, "");
    setMtime(lock, 1059);
    // Only parent mtime (1000s = 1_000_000ms) counts → age = now - 1_000_000ms
    expect(
      transcriptAgeMs(
        { bgJobId: SHORT },
        { now: 1_060_000, projectsRoot: join(ROOT, "projects"), resolveSession: resolver },
      ),
    ).toBe(60_000);
  });

  test("missing subagents dir tolerated — parent-only age", () => {
    const parent = join(ROOT, "projects", PROJ, `${SID}.jsonl`);
    writeFileSync(parent, "{}\n");
    setMtime(parent, 1000);
    // no subagents dir at all
    expect(
      transcriptAgeMs(
        { bgJobId: SHORT },
        { now: 1_060_000, projectsRoot: join(ROOT, "projects"), resolveSession: resolver },
      ),
    ).toBe(60_000);
  });

  test("reads bg_job_id from raw.bg_job_id (parsed signal shape)", () => {
    const parent = join(ROOT, "projects", PROJ, `${SID}.jsonl`);
    writeFileSync(parent, "{}\n");
    setMtime(parent, 1000);
    // signal with nested raw
    expect(
      transcriptAgeMs(
        { raw: { bg_job_id: SHORT } },
        { now: 1_060_000, projectsRoot: join(ROOT, "projects"), resolveSession: resolver },
      ),
    ).toBe(60_000);
  });

  test("no signal at all → null (no crash)", () => {
    expect(transcriptAgeMs(null, { now: 1, resolveSession: resolver })).toBeNull();
    expect(transcriptAgeMs(undefined, { now: 1, resolveSession: resolver })).toBeNull();
  });

  test("CTL-729 coverage: reads bg id from the liveness:{kind:'bg',value} shape (3rd fallback)", () => {
    // The scheduler passes a parsed signal whose id may arrive via the liveness
    // shape (signalLike.liveness.kind === 'bg'); only the flat {bgJobId} and
    // {raw.bg_job_id} extraction paths were covered.
    const parent = join(ROOT, "projects", PROJ, `${SID}.jsonl`);
    writeFileSync(parent, "{}\n");
    setMtime(parent, 1000);
    expect(
      transcriptAgeMs(
        { liveness: { kind: "bg", value: SHORT } },
        { now: 1_060_000, projectsRoot: join(ROOT, "projects"), resolveSession: resolver },
      ),
    ).toBe(60_000);
  });

  test("CTL-729 coverage: file resolves but stat throws → null (fail-safe = not silent)", () => {
    // resolveTranscriptPath finds the file, but stat throws (e.g. deleted between
    // resolve and stat) → mtimeMs returns 0 → newest is falsy → age is null. The
    // watchdog must NOT treat an unstat-able transcript as silent.
    const parent = join(ROOT, "projects", PROJ, `${SID}.jsonl`);
    writeFileSync(parent, "{}\n");
    const throwingStat = () => { throw new Error("ENOENT: stat raced a delete"); };
    expect(
      transcriptAgeMs(
        { bgJobId: SHORT },
        {
          now: 1_060_000,
          projectsRoot: join(ROOT, "projects"),
          resolveSession: resolver,
          stat: throwingStat,
        },
      ),
    ).toBeNull();
  });
});

describe("resolveTranscriptPath", () => {
  test("fast path: slug derived from worktreePath matches dir", () => {
    const projDir = join(ROOT, "projects", PROJ);
    mkdirSync(projDir, { recursive: true });
    const f = join(projDir, `${SID}.jsonl`);
    writeFileSync(f, "");
    const worktreePath = PROJ.replace(/-/g, "/").replace(/\//g, "/"); // rough reverse slug
    // Direct slug check: the slugFor(wt) path should match PROJ
    const result = resolveTranscriptPath(SID, {
      projectsRoot: join(ROOT, "projects"),
      worktreePath: PROJ.replace(/-/g, "/"), // produces slug matching PROJ
    });
    // Either fast-path or scan finds the file
    expect(result).toBe(f);
  });

  test("fallback scan: finds transcript without worktreePath", () => {
    const f = join(ROOT, "projects", PROJ, `${SID}.jsonl`);
    writeFileSync(f, "");
    const result = resolveTranscriptPath(SID, { projectsRoot: join(ROOT, "projects") });
    expect(result).toBe(f);
  });

  test("returns null when no match", () => {
    expect(
      resolveTranscriptPath("no-such-session", { projectsRoot: join(ROOT, "projects") }),
    ).toBeNull();
  });

  test("null sessionId → null", () => {
    expect(resolveTranscriptPath(null)).toBeNull();
  });
});

describe("slugFor", () => {
  test("replaces slashes and dots with dashes", () => {
    expect(slugFor("/Users/foo/wt/CTL-729")).toBe("-Users-foo-wt-CTL-729");
  });
  test("null input → null", () => {
    expect(slugFor(null)).toBeNull();
  });
});

test("module imports without circular-import crash", async () => {
  const m = await import("./transcript-silence.mjs");
  expect(typeof m.transcriptAgeMs).toBe("function");
  expect(typeof m.resolveTranscriptPath).toBe("function");
  expect(typeof m.slugFor).toBe("function");
});
