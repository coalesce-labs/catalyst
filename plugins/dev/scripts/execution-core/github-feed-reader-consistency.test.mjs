// CTL-2011: Phase 2 tests — catalyst doctor cross-reader check.
// Run: cd plugins/dev/scripts && bun test execution-core/github-feed-reader-consistency.test.mjs

import { describe, expect, it } from "bun:test";
import { checkGithubFeedReaderConsistency, checksForClass } from "./doctor.mjs";

// ─── nodeClassOf helper (mirrors the pattern in doctor.test.mjs) ─────────────
const nodeClassOf = (over = {}) => ({
  class: "worker",
  source: "layer2",
  inferred: false,
  recognized: true,
  raw: "worker",
  ...over,
});

// ─── checkGithubFeedReaderConsistency ────────────────────────────────────────

describe("checkGithubFeedReaderConsistency", () => {
  // ── Positive control (must FAIL) ──────────────────────────────────────────
  it("⛔ POSITIVE CONTROL: split host → FAIL naming both modes/layers", () => {
    // env file carries CATALYST_GITHUB_FEED=shadow; Layer-2 (via resolveGithubFeedMode)
    // would return "enforce". The broker/monitor strip the env-file pin and see only
    // Layer-2 → "enforce". Execution-core overlays the pin → "shadow". Split → FAIL.
    const result = checkGithubFeedReaderConsistency({
      // Strip ambient env of any real GITHUB_FEED pin so the test is hermetic.
      env: {},
      readEnvFileFn: (_p) => "export CATALYST_GITHUB_FEED=shadow\n",
      // Use resolveGithubFeedMode with a custom layer2 response: return "enforce" for
      // the broker view (no env pin, so Layer-2 "enforce" would come from config).
      // We simulate Layer-2=enforce by injecting a resolver that:
      //   - with CATALYST_GITHUB_FEED=shadow → resolves shadow (env wins)
      //   - without CATALYST_GITHUB_FEED      → would resolve from Layer-2
      // We need Layer-2 to say "enforce". The easiest way is to use a fake resolver.
      resolveGithubFeedModeFn: ({ env: e = {} } = {}) => {
        // Mimic the real ladder: env pin > layer2 > default.
        const pin = e?.CATALYST_GITHUB_FEED;
        if (typeof pin === "string" && pin.trim().length > 0) {
          const VALID = ["off", "shadow", "enforce"];
          if (pin === "0") return { mode: "off", intervalSec: 30, source: "env" };
          if (VALID.includes(pin)) return { mode: pin, intervalSec: 30, source: "env" };
          return { mode: "off", intervalSec: 30, source: "env-invalid" };
        }
        // No env pin → simulate Layer-2 returning "enforce".
        return { mode: "enforce", intervalSec: 30, source: "layer2" };
      },
    });

    expect(result).toHaveLength(1);
    const check = result[0];
    expect(check.name).toBe("github-feed-reader-consistency");
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("shadow");
    expect(check.detail).toContain("enforce");
    // Detail must identify the env source
    expect(check.detail).toMatch(/source=env/);
    // Detail must identify the layer2 source
    expect(check.detail).toMatch(/source=layer2/);
  });

  // ── Agree case: no pin (must PASS) ────────────────────────────────────────
  it("no env pin, no Layer-2 → both views resolve 'off' → PASS", () => {
    const result = checkGithubFeedReaderConsistency({
      env: {},
      readEnvFileFn: (_p) => "", // empty file → no pin
      resolveGithubFeedModeFn: ({ env: e = {} } = {}) => {
        const pin = e?.CATALYST_GITHUB_FEED;
        if (typeof pin === "string" && pin.trim().length > 0) {
          if (pin === "0") return { mode: "off", intervalSec: 30, source: "env" };
          const VALID = ["off", "shadow", "enforce"];
          if (VALID.includes(pin)) return { mode: pin, intervalSec: 30, source: "env" };
          return { mode: "off", intervalSec: 30, source: "env-invalid" };
        }
        return { mode: "off", intervalSec: 30, source: "default" };
      },
    });

    expect(result).toHaveLength(1);
    expect(result[0].status).toBe("pass");
    expect(result[0].detail).toContain("off");
  });

  // ── No pin, Layer-2 enforce (must PASS) ───────────────────────────────────
  it("no env-file pin, Layer-2 enforce → both views resolve 'enforce' → PASS", () => {
    const result = checkGithubFeedReaderConsistency({
      env: {},
      readEnvFileFn: (_p) => "", // no pin
      resolveGithubFeedModeFn: ({ env: e = {} } = {}) => {
        const pin = e?.CATALYST_GITHUB_FEED;
        if (typeof pin === "string" && pin.trim().length > 0) {
          return { mode: "enforce", intervalSec: 30, source: "env" };
        }
        return { mode: "enforce", intervalSec: 30, source: "layer2" };
      },
    });

    expect(result).toHaveLength(1);
    expect(result[0].status).toBe("pass");
    expect(result[0].detail).toContain("enforce");
  });

  // ── Same pin in env file as in Layer-2 (must PASS) ────────────────────────
  it("env-file pin=enforce matches Layer-2 enforce → both views agree → PASS", () => {
    const result = checkGithubFeedReaderConsistency({
      env: {},
      readEnvFileFn: (_p) => "export CATALYST_GITHUB_FEED=enforce\n",
      resolveGithubFeedModeFn: ({ env: e = {} } = {}) => {
        const pin = e?.CATALYST_GITHUB_FEED;
        if (typeof pin === "string" && pin.trim() === "enforce") {
          return { mode: "enforce", intervalSec: 30, source: "env" };
        }
        // No pin → Layer-2 = enforce
        return { mode: "enforce", intervalSec: 30, source: "layer2" };
      },
    });

    expect(result).toHaveLength(1);
    expect(result[0].status).toBe("pass");
  });

  // ── INCONCLUSIVE: readEnvFileFn throws non-ENOENT error ───────────────────
  it("readEnvFileFn throws → WARN (inconclusive, cannot compare)", () => {
    const result = checkGithubFeedReaderConsistency({
      env: {},
      readEnvFileFn: (_p) => {
        const err = new Error("EACCES: permission denied");
        err.code = "EACCES";
        throw err;
      },
      resolveGithubFeedModeFn: () => ({ mode: "off", intervalSec: 30, source: "default" }),
    });

    expect(result).toHaveLength(1);
    expect(result[0].status).toBe("warn");
    expect(result[0].detail.toLowerCase()).toMatch(/could not read/);
  });

  // ── Env file absent (ENOENT) → treated as no pin → PASS ─────────────────
  it("env file absent (ENOENT thrown by default readFn) → no pin → agree → PASS", () => {
    // The default readEnvFileFn converts ENOENT to "" (no pin); non-ENOENT throws.
    // Simulate by passing a fn that returns "" for ENOENT:
    const result = checkGithubFeedReaderConsistency({
      env: {},
      readEnvFileFn: (_p) => {
        const err = new Error("ENOENT: no such file");
        err.code = "ENOENT";
        throw err;
      },
      resolveGithubFeedModeFn: ({ env: e = {} } = {}) => {
        const pin = e?.CATALYST_GITHUB_FEED;
        if (typeof pin === "string" && pin.trim().length > 0) {
          return { mode: pin, intervalSec: 30, source: "env" };
        }
        return { mode: "off", intervalSec: 30, source: "default" };
      },
    });

    // ENOENT is a valid "no pin" answer — treat as agree, not inconclusive.
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe("pass");
  });
});

// ─── checksForClass registration ──────────────────────────────────────────────

describe("checksForClass — checkGithubFeedReaderConsistency registration", () => {
  it("worker rubric includes checkGithubFeedReaderConsistency", () => {
    const src = checksForClass(nodeClassOf({ class: "worker", raw: "worker" }))
      .map((f) => f.toString())
      .join("\n");
    expect(src).toContain("checkGithubFeedReaderConsistency");
  });

  it("monitor rubric does NOT include checkGithubFeedReaderConsistency (worker-only)", () => {
    const src = checksForClass(nodeClassOf({ class: "monitor", raw: "monitor" }))
      .map((f) => f.toString())
      .join("\n");
    expect(src).not.toContain("checkGithubFeedReaderConsistency");
  });

  it("developer rubric does NOT include checkGithubFeedReaderConsistency (worker-only)", () => {
    const src = checksForClass(nodeClassOf({ class: "developer", raw: "developer" }))
      .map((f) => f.toString())
      .join("\n");
    expect(src).not.toContain("checkGithubFeedReaderConsistency");
  });
});
