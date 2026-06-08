// host-identity.test.mjs — tests for hostName() / hostId() in execution-core/lib/host-identity.mjs
// Run: cd plugins/dev/scripts/execution-core && bun test host-identity

import { describe, test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { hostName, hostId } from "../lib/host-identity.mjs";

function sha256Hex(input) {
  return createHash("sha256").update(input).digest("hex");
}

describe("hostName", () => {
  test("strips .local suffix", () => {
    expect(hostName({ raw: "my-mac.local" })).toBe("my-mac");
  });

  test("leaves hostname without .local intact", () => {
    expect(hostName({ raw: "my-mac" })).toBe("my-mac");
  });

  test("explicit override wins over raw", () => {
    expect(hostName({ raw: "my-mac.local", override: "alias-1" })).toBe("alias-1");
  });

  test("CATALYST_HOST_NAME env wins when no explicit override", () => {
    const orig = process.env.CATALYST_HOST_NAME;
    process.env.CATALYST_HOST_NAME = "env-alias";
    try {
      expect(hostName({ raw: "my-mac.local" })).toBe("env-alias");
    } finally {
      if (orig === undefined) delete process.env.CATALYST_HOST_NAME;
      else process.env.CATALYST_HOST_NAME = orig;
    }
  });

  test("returns non-empty string with no args", () => {
    const name = hostName();
    expect(typeof name).toBe("string");
    expect(name.length).toBeGreaterThan(0);
  });

  test("result has no .local suffix by default", () => {
    expect(hostName()).not.toMatch(/\.local$/);
  });
});

describe("hostId", () => {
  test("is sha256(hostName)[:16]", () => {
    expect(hostId({ raw: "my-mac" })).toBe(sha256Hex("my-mac").slice(0, 16));
  });

  test("is exactly 16 lowercase hex chars", () => {
    const id = hostId({ raw: "my-mac" });
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  test("deterministic for same input", () => {
    expect(hostId({ raw: "stable-host" })).toBe(hostId({ raw: "stable-host" }));
  });

  test("different hostnames produce different ids", () => {
    expect(hostId({ raw: "host-a" })).not.toBe(hostId({ raw: "host-b" }));
  });

  test("CATALYST_HOST_NAME override flows into host.id", () => {
    const orig = process.env.CATALYST_HOST_NAME;
    process.env.CATALYST_HOST_NAME = "alias-1";
    try {
      expect(hostId()).toBe(sha256Hex("alias-1").slice(0, 16));
    } finally {
      if (orig === undefined) delete process.env.CATALYST_HOST_NAME;
      else process.env.CATALYST_HOST_NAME = orig;
    }
  });
});
