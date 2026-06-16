// write-secret-config.test.mjs — CTL-1203. writeSecretConfig unit tests.
// Run: cd plugins/dev/scripts/execution-core && bun test write-secret-config.test.mjs

import { describe, test, expect, afterEach } from "bun:test";
import { mkdirSync, statSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeSecretConfig } from "./write-secret-config.mjs";

let scratch;

function makeScratch() {
  scratch = join(tmpdir(), `write-secret-config-test-${Math.floor(Date.now() / 1000)}-${process.pid}`);
  mkdirSync(scratch, { recursive: true });
  return scratch;
}

afterEach(() => {
  if (scratch && existsSync(scratch)) {
    rmSync(scratch, { recursive: true, force: true });
  }
});

describe("writeSecretConfig (CTL-1203)", () => {
  test("creates parent dir if missing", () => {
    const dir = join(makeScratch(), "deep", "nested");
    const path = join(dir, "config.json");
    writeSecretConfig(path, { key: "value" });
    expect(existsSync(path)).toBe(true);
  });

  test("writes valid JSON that round-trips via JSON.parse", () => {
    const path = join(makeScratch(), "config.json");
    writeSecretConfig(path, { catalyst: { projectKey: "CTL" } });
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    expect(parsed).toEqual({ catalyst: { projectKey: "CTL" } });
  });

  test("resulting file mode is 0o600", () => {
    const path = join(makeScratch(), "config.json");
    writeSecretConfig(path, { secret: "value" });
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("overwrites existing 0o644 file and leaves it 0o600", () => {
    const path = join(makeScratch(), "config.json");
    writeFileSync(path, '{"old":1}', { mode: 0o644 });
    writeSecretConfig(path, { new: 2 });
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    expect(parsed.new).toBe(2);
  });

  test("merge semantics: deep-merges obj into existing file without clobbering unrelated keys", () => {
    const path = join(makeScratch(), "config.json");
    writeSecretConfig(path, { catalyst: { projectKey: "CTL", existingKey: "keep" } });
    writeSecretConfig(path, { catalyst: { newKey: "added" } });
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    expect(parsed.catalyst.projectKey).toBe("CTL");
    expect(parsed.catalyst.existingKey).toBe("keep");
    expect(parsed.catalyst.newKey).toBe("added");
  });
});
