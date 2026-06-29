// config-cloud-token-env.test.mjs — tests for resolveNodeCloudTokenEnv() in
// execution-core/config.mjs (CTL-1394). The resolver returns the env-var NAME that
// holds this node's Catalyst-Cloud token — never the secret VALUE. Run:
//   cd plugins/dev/scripts/execution-core && bun test config-cloud-token-env

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveNodeCloudTokenEnv } from "../config.mjs";

const ENV_KEYS = ["CATALYST_CLOUD_TOKEN_ENV", "CATALYST_LAYER2_CONFIG_FILE", "CATALYST_HOST_NAME"];
let saved;
let tmp;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  tmp = mkdtempSync(join(tmpdir(), "ctl1394-"));
  // Point Layer-2 at a guaranteed-absent file so an ambient ~/.config/catalyst/config.json
  // never leaks into a test, and clear the env overrides.
  delete process.env.CATALYST_CLOUD_TOKEN_ENV;
  delete process.env.CATALYST_HOST_NAME;
  process.env.CATALYST_LAYER2_CONFIG_FILE = join(tmp, "absent.json");
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
});

function writeLayer2(obj) {
  const p = join(tmp, "config.json");
  writeFileSync(p, JSON.stringify(obj));
  process.env.CATALYST_LAYER2_CONFIG_FILE = p;
}

describe("resolveNodeCloudTokenEnv — host table", () => {
  // The table is deliberately not algorithmic (mini-2 → MINI_1, office-desk/laptop →
  // WORKSTATION); assert each non-derivable mapping explicitly.
  for (const [host, envVar] of [
    ["laptop", "CATALYST_CLOUD_WORKSTATION_TOKEN"],
    ["office-desk", "CATALYST_CLOUD_WORKSTATION_TOKEN"],
    ["mini", "CATALYST_MINI_ACCOUNT_TOKEN"],
    ["mini-2", "CATALYST_MINI_1_ACCOUNT_TOKEN"],
  ]) {
    test(`host "${host}" → ${envVar}, source=table`, () => {
      expect(resolveNodeCloudTokenEnv({ hostName: host })).toEqual({ envVar, source: "table" });
    });
  }

  test("unknown host, no overrides → shared CATALYST_CLOUD_TOKEN, source=fallback", () => {
    expect(resolveNodeCloudTokenEnv({ hostName: "some-new-node" })).toEqual({
      envVar: "CATALYST_CLOUD_TOKEN",
      source: "fallback",
    });
  });
});

describe("resolveNodeCloudTokenEnv — overrides", () => {
  test("CATALYST_CLOUD_TOKEN_ENV env override wins over table", () => {
    process.env.CATALYST_CLOUD_TOKEN_ENV = "MY_CUSTOM_TOKEN";
    expect(resolveNodeCloudTokenEnv({ hostName: "mini" })).toEqual({
      envVar: "MY_CUSTOM_TOKEN",
      source: "env",
    });
  });

  test("empty env override is ignored (falls through to table)", () => {
    process.env.CATALYST_CLOUD_TOKEN_ENV = "";
    expect(resolveNodeCloudTokenEnv({ hostName: "mini" })).toEqual({
      envVar: "CATALYST_MINI_ACCOUNT_TOKEN",
      source: "table",
    });
  });

  test("Layer-2 catalyst.cloud.tokenEnv override (env unset) wins over table", () => {
    writeLayer2({ catalyst: { cloud: { tokenEnv: "L2_TOKEN" } } });
    expect(resolveNodeCloudTokenEnv({ hostName: "mini" })).toEqual({
      envVar: "L2_TOKEN",
      source: "layer2",
    });
  });

  test("env override beats Layer-2 override", () => {
    writeLayer2({ catalyst: { cloud: { tokenEnv: "L2_TOKEN" } } });
    process.env.CATALYST_CLOUD_TOKEN_ENV = "ENV_TOKEN";
    expect(resolveNodeCloudTokenEnv({ hostName: "mini" })).toEqual({
      envVar: "ENV_TOKEN",
      source: "env",
    });
  });

  test("malformed Layer-2 file never throws → falls through to table", () => {
    const p = join(tmp, "config.json");
    writeFileSync(p, "{ not json");
    process.env.CATALYST_LAYER2_CONFIG_FILE = p;
    expect(resolveNodeCloudTokenEnv({ hostName: "mini-2" })).toEqual({
      envVar: "CATALYST_MINI_1_ACCOUNT_TOKEN",
      source: "table",
    });
  });
});

describe("resolveNodeCloudTokenEnv — NAME-only invariant", () => {
  test("never reads the secret VALUE (resolves even when the var holds a sentinel)", () => {
    // Set the resolved var to a sentinel; the resolver must return the NAME and never
    // surface the value anywhere in its result.
    const SENTINEL = "lin_secret_should_never_appear";
    process.env.CATALYST_MINI_ACCOUNT_TOKEN = SENTINEL;
    try {
      const r = resolveNodeCloudTokenEnv({ hostName: "mini" });
      expect(r).toEqual({ envVar: "CATALYST_MINI_ACCOUNT_TOKEN", source: "table" });
      expect(JSON.stringify(r)).not.toContain(SENTINEL);
    } finally {
      delete process.env.CATALYST_MINI_ACCOUNT_TOKEN;
    }
  });

  test("defaults hostName from getHostName() when omitted (no throw)", () => {
    // With CATALYST_HOST_NAME pinned, the default-arg path resolves deterministically.
    process.env.CATALYST_HOST_NAME = "mini-2";
    expect(resolveNodeCloudTokenEnv()).toEqual({
      envVar: "CATALYST_MINI_1_ACCOUNT_TOKEN",
      source: "table",
    });
  });
});
