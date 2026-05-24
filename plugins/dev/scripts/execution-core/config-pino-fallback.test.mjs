// CTL-578 — config.mjs must not crash module-load when `pino` is unresolvable.
// Run: cd plugins/dev/scripts/execution-core && bun test config-pino-fallback.test.mjs
//
// The execution-core daemon copy ships with `node_modules/pino` present. A
// worktree checkout that hasn't run `bun install` does not, and any module
// graph that depends on config.mjs (registry.mjs, monitor.mjs, …) used to
// crash at module-load before any code ran. Phase 3 of CTL-578 wraps the
// `pino` import in try/catch and substitutes a console-shim with the same
// surface. These tests exercise the shim by staging config.mjs in a scratch
// dir whose package.json declares no deps, so pino is genuinely unresolvable.

import { describe, test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_MJS = resolve(__dirname, "config.mjs");

// The runtime used to spawn probes. Bun auto-installs missing packages in the
// runtime (defeating the missing-pino repro), so we deliberately invoke this
// suite under a runtime that does NOT auto-install. Preference order:
//   1. `node` (true Node — no auto-install path exists).
//   2. `bun --no-install` (Bun's switch that disables runtime auto-install).
function pickProbeCommand() {
  // Search PATH for `node` without spawning a shell.
  const which = spawnSync("which", ["node"], { encoding: "utf8" });
  if (which.status === 0 && which.stdout.trim()) {
    return { cmd: which.stdout.trim(), prefix: [] };
  }
  // Fallback: same runtime as the test (bun) with --no-install.
  return { cmd: process.execPath, prefix: ["--no-install"] };
}

function stageScratch() {
  const scratch = mkdtempSync(join(tmpdir(), "ctl-578-pino-"));
  cpSync(CONFIG_MJS, join(scratch, "config.mjs"));
  // type:module + no deps -> pino unresolvable from this directory tree.
  writeFileSync(
    join(scratch, "package.json"),
    JSON.stringify({ type: "module", name: "ctl-578-pino-fallback-fixture" }),
  );
  return scratch;
}

describe("config.mjs pino fallback (CTL-578)", () => {
  test("module-load survives when pino is unresolvable", () => {
    const scratch = stageScratch();
    const probe = `
      import { log } from "./config.mjs";
      log.info({ probe: true }, "hello");
      log.warn("warn-msg");
      log.error("err-msg");
      process.stdout.write("LOADED_OK\\n");
    `;
    writeFileSync(join(scratch, "probe.mjs"), probe);

    const { cmd, prefix } = pickProbeCommand();
    const result = spawnSync(cmd, [...prefix, "probe.mjs"], {
      cwd: scratch,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/LOADED_OK/);
  });

  test("shim exposes the standard pino-compatible methods + child()", () => {
    const scratch = stageScratch();
    const probe = `
      import { log } from "./config.mjs";
      const methods = ["info","warn","error","debug","fatal","trace","child"];
      for (const m of methods) {
        if (typeof log[m] !== "function") {
          process.stderr.write("missing " + m + "\\n");
          process.exit(2);
        }
      }
      const child = log.child({ comp: "x" });
      if (typeof child.info !== "function") process.exit(3);
      process.exit(0);
    `;
    writeFileSync(join(scratch, "probe.mjs"), probe);

    const { cmd, prefix } = pickProbeCommand();
    const result = spawnSync(cmd, [...prefix, "probe.mjs"], {
      cwd: scratch,
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
  });
});
