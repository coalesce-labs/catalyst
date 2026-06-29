// config-cloud-token-env.test.mjs — tests for resolveNodeCloudTokenEnv() in
// execution-core/config.mjs (CTL-1394). The resolver returns the env-var NAME that
// holds this node's Catalyst-Cloud token — never the secret VALUE. Run:
//   cd plugins/dev/scripts/execution-core && bun test config-cloud-token-env

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveNodeCloudTokenEnv } from "../config.mjs";

const ENV_KEYS = ["CATALYST_CLOUD_TOKEN_ENV", "CATALYST_CLOUD_TOKEN", "CATALYST_LAYER2_CONFIG_FILE", "CATALYST_HOST_NAME"];
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

describe("resolveNodeCloudTokenEnv — default (host-agnostic, no node names in code)", () => {
  test("no overrides → standard CATALYST_CLOUD_TOKEN, source=default (same on every host)", () => {
    expect(resolveNodeCloudTokenEnv()).toEqual({ envVar: "CATALYST_CLOUD_TOKEN", source: "default" });
  });

  test("the result does NOT depend on the host name (portable to arbitrary hosts)", () => {
    // Pinning any host identity must not change the resolved NAME — proves no node names
    // are baked into the resolver (the whole point of this change).
    for (const host of ["mini", "mini-2", "laptop", "some-brand-new-box", "ci-runner-7"]) {
      process.env.CATALYST_HOST_NAME = host;
      expect(resolveNodeCloudTokenEnv()).toEqual({ envVar: "CATALYST_CLOUD_TOKEN", source: "default" });
    }
  });
});

describe("resolveNodeCloudTokenEnv — overrides (per-host config, not code)", () => {
  test("CATALYST_CLOUD_TOKEN_ENV env override wins over the default", () => {
    process.env.CATALYST_CLOUD_TOKEN_ENV = "MY_CUSTOM_TOKEN";
    expect(resolveNodeCloudTokenEnv()).toEqual({ envVar: "MY_CUSTOM_TOKEN", source: "env" });
  });

  test("empty env override is ignored (falls through to the default)", () => {
    process.env.CATALYST_CLOUD_TOKEN_ENV = "";
    expect(resolveNodeCloudTokenEnv()).toEqual({ envVar: "CATALYST_CLOUD_TOKEN", source: "default" });
  });

  test("Layer-2 catalyst.cloud.tokenEnv override (env unset) wins over the default", () => {
    writeLayer2({ catalyst: { cloud: { tokenEnv: "L2_TOKEN" } } });
    expect(resolveNodeCloudTokenEnv()).toEqual({ envVar: "L2_TOKEN", source: "layer2" });
  });

  test("env override beats Layer-2 override", () => {
    writeLayer2({ catalyst: { cloud: { tokenEnv: "L2_TOKEN" } } });
    process.env.CATALYST_CLOUD_TOKEN_ENV = "ENV_TOKEN";
    expect(resolveNodeCloudTokenEnv()).toEqual({ envVar: "ENV_TOKEN", source: "env" });
  });

  test("malformed Layer-2 file never throws → falls through to the default", () => {
    const p = join(tmp, "config.json");
    writeFileSync(p, "{ not json");
    process.env.CATALYST_LAYER2_CONFIG_FILE = p;
    expect(resolveNodeCloudTokenEnv()).toEqual({ envVar: "CATALYST_CLOUD_TOKEN", source: "default" });
  });
});

describe("resolveNodeCloudTokenEnv — NAME-only invariant", () => {
  test("never reads the secret VALUE (resolves even when the var holds a sentinel)", () => {
    const SENTINEL = "lin_secret_should_never_appear";
    process.env.CATALYST_CLOUD_TOKEN = SENTINEL;
    try {
      const r = resolveNodeCloudTokenEnv();
      expect(r).toEqual({ envVar: "CATALYST_CLOUD_TOKEN", source: "default" });
      expect(JSON.stringify(r)).not.toContain(SENTINEL);
    } finally {
      delete process.env.CATALYST_CLOUD_TOKEN;
    }
  });
});
