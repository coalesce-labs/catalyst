// Unit tests for lib/project-setup.ts (CTL-1154).
// Run: cd plugins/dev/scripts/orch-monitor && bun test project-setup.test.ts

import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProjectSetup } from "./lib/project-setup";

const okRunner = () => Promise.resolve({ exitCode: 0, stdout: "{}" });

describe("runProjectSetup (CTL-1154)", () => {
  it("pre-flight: a repoRoot that does not exist → ready=false with a failed repoRoot step, runner NOT called", async () => {
    let called = false;
    const r = await runProjectSetup({
      configPath: "/x/config.json",
      key: "EVR",
      vcsRepo: "coalesce-labs/evergreen",
      repoRoot: "/no/such/path/should/not/exist",
      runner: () => {
        called = true;
        return Promise.resolve({ exitCode: 0, stdout: "" });
      },
    });
    expect(r.ready).toBe(false);
    const repoRootStep = r.steps.find((s) => s.id === "repoRoot");
    expect(repoRootStep).toBeDefined();
    expect(repoRootStep?.status).toBe("failed");
    expect(called).toBe(false);
  });

  it("exit 0 → ready=true, all steps ok", async () => {
    const dir = mkdtempSync(join(tmpdir(), "project-setup-test-"));
    try {
      const r = await runProjectSetup({
        configPath: "/x/config.json",
        key: "EVR",
        vcsRepo: "coalesce-labs/evergreen",
        repoRoot: dir,
        runner: okRunner,
      });
      expect(r.ready).toBe(true);
      expect(r.exitCode).toBe(0);
      expect(r.steps.every((s) => s.status === "ok")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exit 3 (states partial) → ready=false, states step failed, others ok", async () => {
    const dir = mkdtempSync(join(tmpdir(), "project-setup-test-"));
    try {
      const r = await runProjectSetup({
        configPath: "/x/config.json",
        key: "EVR",
        vcsRepo: "coalesce-labs/evergreen",
        repoRoot: dir,
        runner: () => Promise.resolve({ exitCode: 3, stdout: "" }),
      });
      expect(r.ready).toBe(false);
      const statesStep = r.steps.find((s) => s.id === "states");
      expect(statesStep?.status).toBe("failed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exit 4 (registry upsert failed) → ready=false, registry step failed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "project-setup-test-"));
    try {
      const r = await runProjectSetup({
        configPath: "/x/config.json",
        key: "EVR",
        vcsRepo: "coalesce-labs/evergreen",
        repoRoot: dir,
        runner: () => Promise.resolve({ exitCode: 4, stdout: "" }),
      });
      expect(r.ready).toBe(false);
      const regStep = r.steps.find((s) => s.id === "registry");
      expect(regStep?.status).toBe("failed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exit 1 (prereq/token missing) → ready=false, prereq step failed with a hint", async () => {
    const dir = mkdtempSync(join(tmpdir(), "project-setup-test-"));
    try {
      const r = await runProjectSetup({
        configPath: "/x/config.json",
        key: "EVR",
        vcsRepo: "coalesce-labs/evergreen",
        repoRoot: dir,
        runner: () => Promise.resolve({ exitCode: 1, stdout: "" }),
      });
      expect(r.ready).toBe(false);
      const prereqStep = r.steps.find((s) => s.id === "prereq");
      expect(prereqStep?.status).toBe("failed");
      expect(prereqStep?.detail).toMatch(/token|prerequisite/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exit 2 (Linear API error) → ready=false, api step failed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "project-setup-test-"));
    try {
      const r = await runProjectSetup({
        configPath: "/x/config.json",
        key: "EVR",
        vcsRepo: "coalesce-labs/evergreen",
        repoRoot: dir,
        runner: () => Promise.resolve({ exitCode: 2, stdout: "" }),
      });
      expect(r.ready).toBe(false);
      const apiStep = r.steps.find((s) => s.id === "api");
      expect(apiStep?.status).toBe("failed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("invokes the runner with --config <path> and --json args", async () => {
    const dir = mkdtempSync(join(tmpdir(), "project-setup-test-"));
    try {
      let capturedArgs: string[] = [];
      const r = await runProjectSetup({
        configPath: "/x/config.json",
        key: "EVR",
        vcsRepo: "coalesce-labs/evergreen",
        repoRoot: dir,
        runner: (args) => {
          capturedArgs = args;
          return Promise.resolve({ exitCode: 0, stdout: "{}" });
        },
      });
      expect(r.ready).toBe(true);
      expect(capturedArgs).toContain("--config");
      expect(capturedArgs).toContain("/x/config.json");
      expect(capturedArgs).toContain("--json");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a runner that throws → ready=false with a setup step failed (fail-open, never throws)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "project-setup-test-"));
    try {
      let threw = false;
      let r;
      try {
        r = await runProjectSetup({
          configPath: "/x/config.json",
          key: "EVR",
          vcsRepo: "coalesce-labs/evergreen",
          repoRoot: dir,
          runner: () => {
            throw new Error("runner exploded");
          },
        });
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
      expect(r?.ready).toBe(false);
      const setupStep = r?.steps.find((s) => s.id === "setup");
      expect(setupStep?.status).toBe("failed");
      expect(setupStep?.detail).toMatch(/runner exploded/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
