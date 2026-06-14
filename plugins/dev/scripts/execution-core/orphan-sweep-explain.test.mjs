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

  // CTL-1065 regression: the earlier tests pass `shimResult.stdout` straight to
  // jq's --argjson and so never exercise the bash quoting the real scripts use.
  // Both write sites originally wrote `--argjson expl "${expl_json:-{}}"`, where
  // bash closes the parameter expansion at the FIRST `}` — so a non-empty value
  // `{"a":1}` expands to `{"a":1}}` (trailing brace → invalid JSON → jq exits 2).
  // These tests run the actual bash expansion to lock that in.

  test("the broken ${var:-{}} expansion produces a trailing brace and fails jq", () => {
    const broken = spawnSync(
      "bash",
      ["-c", 'printf "%s" "${expl_json:-{}}" | jq -e . >/dev/null'],
      { env: { ...process.env, expl_json: '{"a":1}' }, encoding: "utf8" },
    );
    // jq must reject the malformed `{"a":1}}` — proving the old pattern was buggy.
    expect(broken.status).not.toBe(0);

    // And confirm the malformed expansion really is the trailing-brace string.
    const expanded = spawnSync(
      "bash",
      ["-c", 'printf "%s" "${expl_json:-{}}"'],
      { env: { ...process.env, expl_json: '{"a":1}' }, encoding: "utf8" },
    );
    expect(expanded.stdout).toBe('{"a":1}}');
  });

  test("the fixed guard + direct expansion merges valid JSON through real bash", () => {
    const sigPath = join(dir, "phase-fixed.json");
    writeFileSync(sigPath, JSON.stringify({
      ticket: "CTL-99", phase: "implement", status: "running",
      bg_job_id: "ab12ef34", updatedAt: "2026-01-01T00:00:00Z",
    }));

    const shimResult = spawnSync("node", [
      SHIM,
      "--ticket", "CTL-99", "--phase", "implement",
      "--what-failed", "orphan-sweep found a stale phase signal for CTL-99/implement",
      "--observed", JSON.stringify({ bgJobId: "ab12ef34", staleMarker: "orphan-sweep-stale" }),
      "--why-gave-up", "the bg job is gone but the signal was never finalized",
      "--human-question", "re-dispatch CTL-99/implement, or mark it abandoned?",
    ], { encoding: "utf8" });
    expect(shimResult.status).toBe(0);

    // Mirror the real script exactly: guard on a prior line, pass the var directly.
    const tmpOut = join(dir, "phase-fixed.out.json");
    const merged = spawnSync(
      "bash",
      ["-c",
        '[ -n "$expl_json" ] || expl_json="{}"; ' +
        'jq --arg ts "2026-01-01T01:00:00Z" --argjson expl "$expl_json" ' +
        "'.status=\"failed\" | .failureReason=\"orphan-sweep-stale\" | .explanation=$expl | .updatedAt=$ts' " +
        '"$sig" > "$out"',
      ],
      { env: { ...process.env, expl_json: shimResult.stdout, sig: sigPath, out: tmpOut }, encoding: "utf8" },
    );
    expect(merged.status).toBe(0);

    const updated = JSON.parse(readFileSync(tmpOut, "utf8"));
    expect(updated.status).toBe("failed");
    expect(updated.failureReason).toBe("orphan-sweep-stale");
    expect(validateExplanation(updated.explanation).valid).toBe(true);
    expect(updated.explanation.observed.bgJobId).toBe("ab12ef34");
  });

  test("the fixed guard supplies {} when the shim value is empty", () => {
    const merged = spawnSync(
      "bash",
      ["-c", '[ -n "$expl_json" ] || expl_json="{}"; printf "%s" "$expl_json" | jq -e . >/dev/null && printf "%s" "$expl_json"'],
      { env: { ...process.env, expl_json: "" }, encoding: "utf8" },
    );
    expect(merged.status).toBe(0);
    expect(merged.stdout).toBe("{}");
  });
});
