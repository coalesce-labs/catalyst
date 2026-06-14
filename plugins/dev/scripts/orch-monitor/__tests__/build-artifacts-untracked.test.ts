import { describe, it, expect } from "bun:test";
import { resolve } from "path";

const monitorRoot = resolve(import.meta.dir, "..");

function git(args: string[]) {
  return Bun.spawnSync(["git", ...args], {
    cwd: monitorRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("build artifacts untracked (CTL-1120)", () => {
  it("public/assets and public/index.html are git-ignored", () => {
    const r = git(["check-ignore", "public/assets/probe.js", "public/index.html"]);
    expect(r.exitCode).toBe(0);
  });

  it("public/assets/* and public/index.html are no longer tracked", () => {
    const out = git(["ls-files", "public/assets", "public/index.html"])
      .stdout.toString()
      .trim();
    expect(out).toBe("");
  });

  it("legitimate statics (favicon, mockups, history.html) are still tracked", () => {
    const out = git([
      "ls-files",
      "public/favicon.svg",
      "public/favicon.ico",
      "public/mockups",
      "public/history.html",
    ])
      .stdout.toString()
      .trim();
    expect(out.length).toBeGreaterThan(0);
  });
});
