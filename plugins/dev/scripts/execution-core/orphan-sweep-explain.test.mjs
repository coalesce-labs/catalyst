// orphan-sweep-explain.test.mjs — CTL-1065 Phase 4: verify the CLI shim pipeline
// that orphan-sweep.sh and phase-agent-dispatch use to splice explanation JSON.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateExplanation } from "./escalation-explanation.mjs";

const SHIM = fileURLToPath(new URL("./escalation-explain.mjs", import.meta.url));

describe("CTL-1065: orphan-sweep explanation pipeline", () => {
  let dir;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "ctl1065-orphan-")); });
  afterAll(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });

  test("shim + jq merge produces a valid explanation in the signal file", () => {
    const sigPath = join(dir, "phase-implement.json");
    writeFileSync(sigPath, JSON.stringify({
      ticket: "CTL-99", phase: "implement", status: "running",
      bg_job_id: "ab12ef34", updatedAt: "2026-01-01T00:00:00Z",
    }));

    // Simulate what orphan-sweep.sh does
    const shimResult = spawnSync("node", [
      SHIM,
      "--ticket", "CTL-99", "--phase", "implement",
      "--what-failed", "orphan-sweep found a stale phase signal for CTL-99/implement",
      "--observed", JSON.stringify({ bgJobId: "ab12ef34", staleMarker: "orphan-sweep-stale" }),
      "--why-gave-up", "the bg job is gone but the signal was never finalized",
      "--human-question", "re-dispatch CTL-99/implement, or mark it abandoned?",
    ], { encoding: "utf8" });
    expect(shimResult.status).toBe(0);

    const expl = JSON.parse(shimResult.stdout);
    expect(validateExplanation(expl).valid).toBe(true);

    // Merge via jq (same pipeline as the shell script)
    const mergeResult = spawnSync("jq", [
      "--arg", "ts", "2026-01-01T01:00:00Z",
      "--argjson", "expl", shimResult.stdout,
      '.status = "failed" | .failureReason = "orphan-sweep-stale" | .explanation = $expl | .updatedAt = $ts',
      sigPath,
    ], { encoding: "utf8" });
    expect(mergeResult.status).toBe(0);

    const updated = JSON.parse(mergeResult.stdout);
    expect(updated.status).toBe("failed");
    expect(updated.failureReason).toBe("orphan-sweep-stale");
    expect(validateExplanation(updated.explanation).valid).toBe(true);
    expect(updated.explanation.observed.bgJobId).toBe("ab12ef34");
  });

  test("shim degrades a tautological question but jq merge still succeeds", () => {
    const shimResult = spawnSync("node", [
      SHIM,
      "--ticket", "CTL-99", "--phase", "implement",
      "--what-failed", "x",
      "--why-gave-up", "y",
      "--human-question", "needs human",
    ], { encoding: "utf8" });
    expect(shimResult.status).toBe(0);
    const expl = JSON.parse(shimResult.stdout);
    expect(expl.degraded).toBe(true);
    expect(validateExplanation(expl).valid).toBe(true);
  });
});
