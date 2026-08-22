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
import { mkdtempSync, mkdirSync, writeFileSync, cpSync } from "node:fs";
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
  const root = mkdtempSync(join(tmpdir(), "ctl-578-pino-"));
  // Mirror the real plugins/dev/scripts/ layout one level deep: config.mjs
  // lives in execution-core/, its sibling config-schema.mjs alongside it, and
  // (CTL-1617) the deployment-mode resolver one directory UP in lib/ — so
  // config.mjs's relative import "../lib/deployment-mode.mjs" resolves
  // exactly as it does in production instead of escaping the fixture root.
  const scratch = join(root, "execution-core");
  const libDir = join(root, "lib");
  mkdirSync(scratch, { recursive: true });
  mkdirSync(libDir, { recursive: true });
  cpSync(CONFIG_MJS, join(scratch, "config.mjs"));
  // CTL-1211: config.mjs imports the dep-free sibling config-schema.mjs — copy it
  // too so the scratch fixture can resolve config.mjs's local (non-pino) imports.
  // (The point of the fixture is that PINO is unresolvable; local siblings must
  // still resolve, so any new sibling/relative import config.mjs gains belongs here.)
  cpSync(resolve(__dirname, "config-schema.mjs"), join(scratch, "config-schema.mjs"));
  // CTL-1617: the zero-import deployment-mode leaf config.mjs re-exports.
  cpSync(resolve(__dirname, "../lib/deployment-mode.mjs"), join(libDir, "deployment-mode.mjs"));
  // CTL-1616 PR5: config.mjs's resolveNodeCloudTokenEnv now delegates to the zero-import
  // secret-contract leaf's resolveCloudTokenName — copy it too so this scratch fixture's
  // module graph resolves identically to production (same rationale as deployment-mode.mjs
  // above).
  cpSync(resolve(__dirname, "../lib/secret-contract.mjs"), join(libDir, "secret-contract.mjs"));
  // CTL-1929: readGithubFeedConfig now delegates to the zero-import github-feed-mode
  // leaf, so it is part of config.mjs's relative-import graph too. ⭐ This test caught
  // the omission on the first full run rather than letting a host discover it — which
  // is exactly the contract the comment above states, working.
  cpSync(resolve(__dirname, "../lib/github-feed-mode.mjs"), join(libDir, "github-feed-mode.mjs"));
  // CTL-1216: getEventLogPath now delegates to the zero-import event-log-paths
  // leaf, so it joins config.mjs's relative-import graph. ⭐ Same story as
  // github-feed-mode above: this fixture caught the omission on the CI run
  // rather than letting a host discover it at load time — the contract stated
  // in the comment above, working a second time.
  cpSync(resolve(__dirname, "../lib/event-log-paths.mjs"), join(libDir, "event-log-paths.mjs"));
  // CTL-1785: config.mjs now imports the entitlement seam — the zero-import
  // ../lib/entitlement.mjs leaf, plus the sibling entitlement-roster.mjs (which
  // itself pulls in entitlement-event.mjs) and execution-core/lib/canonical-event.mjs
  // (which pulls in catalyst-resource.mjs -> host-identity.mjs + node-class.mjs, the
  // last of which delegates back to the already-staged lib/secret-contract.mjs). Every
  // file in that closure must be mirrored here for the same reason as the entries
  // above — same rationale as the CTL-1929 entry that caught the prior omission.
  cpSync(resolve(__dirname, "../lib/entitlement.mjs"), join(libDir, "entitlement.mjs"));
  cpSync(resolve(__dirname, "entitlement-roster.mjs"), join(scratch, "entitlement-roster.mjs"));
  cpSync(resolve(__dirname, "entitlement-event.mjs"), join(scratch, "entitlement-event.mjs"));
  const scratchLibDir = join(scratch, "lib");
  mkdirSync(scratchLibDir, { recursive: true });
  cpSync(resolve(__dirname, "lib/canonical-event.mjs"), join(scratchLibDir, "canonical-event.mjs"));
  cpSync(resolve(__dirname, "lib/catalyst-resource.mjs"), join(scratchLibDir, "catalyst-resource.mjs"));
  cpSync(resolve(__dirname, "lib/host-identity.mjs"), join(scratchLibDir, "host-identity.mjs"));
  cpSync(resolve(__dirname, "lib/node-class.mjs"), join(scratchLibDir, "node-class.mjs"));
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
