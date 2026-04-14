import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openDb, closeDb, getAnnotation } from "../lib/annotations";

let tmpDir: string;
let dbPath: string;

function run(...args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const script = join(import.meta.dir, "..", "catalyst-session.ts");
  const result = Bun.spawnSync(["bun", script, ...args], {
    env: { ...process.env, CATALYST_DIR: tmpDir },
    cwd: import.meta.dir,
  });
  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    exitCode: result.exitCode,
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "catalyst-session-test-"));
  dbPath = join(tmpDir, "annotations.db");
  openDb(dbPath);
});

afterEach(() => {
  closeDb();
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("catalyst-session CLI", () => {
  it("prints usage when called with no args", () => {
    const { stderr, exitCode } = run();
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Usage:");
  });

  it("prints usage for unknown commands", () => {
    const { stderr, exitCode } = run("unknown-cmd");
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Usage:");
  });

  describe("annotate", () => {
    it("sets a display name", () => {
      const { exitCode } = run("annotate", "CTL-1", "--name", "my worker");
      expect(exitCode).toBe(0);
      closeDb();
      openDb(dbPath);
      const ann = getAnnotation("CTL-1");
      expect(ann!.displayName).toBe("my worker");
    });

    it("adds a flag", () => {
      const { exitCode } = run("annotate", "CTL-2", "--flag", "starred");
      expect(exitCode).toBe(0);
      closeDb();
      openDb(dbPath);
      const ann = getAnnotation("CTL-2");
      expect(ann!.flags).toContain("starred");
    });

    it("removes a flag with --unflag", () => {
      run("annotate", "CTL-2", "--flag", "starred");
      run("annotate", "CTL-2", "--unflag", "starred");
      closeDb();
      openDb(dbPath);
      const ann = getAnnotation("CTL-2");
      expect(ann!.flags).not.toContain("starred");
    });

    it("adds a note", () => {
      const { exitCode } = run("annotate", "CTL-3", "--note", "flaky test");
      expect(exitCode).toBe(0);
      closeDb();
      openDb(dbPath);
      const ann = getAnnotation("CTL-3");
      expect(ann!.notes.length).toBe(1);
      expect(ann!.notes[0].text).toBe("flaky test");
    });

    it("adds tags", () => {
      const { exitCode } = run(
        "annotate", "CTL-4", "--tag", "refactor", "--tag", "high-cost",
      );
      expect(exitCode).toBe(0);
      closeDb();
      openDb(dbPath);
      const ann = getAnnotation("CTL-4");
      expect(ann!.tags).toContain("refactor");
      expect(ann!.tags).toContain("high-cost");
    });

    it("removes a tag with --untag", () => {
      run("annotate", "CTL-4", "--tag", "refactor");
      run("annotate", "CTL-4", "--untag", "refactor");
      closeDb();
      openDb(dbPath);
      const ann = getAnnotation("CTL-4");
      expect(ann!.tags).not.toContain("refactor");
    });

    it("clears all annotations with --clear", () => {
      run("annotate", "CTL-5", "--name", "test", "--flag", "starred");
      run("annotate", "CTL-5", "--clear");
      closeDb();
      openDb(dbPath);
      const ann = getAnnotation("CTL-5");
      expect(ann).toBeNull();
    });

    it("requires a session-id argument", () => {
      const { stderr, exitCode } = run("annotate");
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("session-id");
    });

    it("requires at least one annotation option", () => {
      const { stderr, exitCode } = run("annotate", "CTL-6");
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("option");
    });
  });
});
