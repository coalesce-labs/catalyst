// config-host.test.mjs — tests for getHostName() in execution-core/config.mjs (CTL-1252)
// Run: cd plugins/dev/scripts/execution-core && bun test config-host

import { describe, test, expect } from "bun:test";
import { getHostName } from "../config.mjs";

describe("getHostName", () => {
  test("CATALYST_HOST_NAME with a dot is returned verbatim", () => {
    const orig = process.env.CATALYST_HOST_NAME;
    process.env.CATALYST_HOST_NAME = "mini.rozich";
    try {
      expect(getHostName()).toBe("mini.rozich");
    } finally {
      if (orig === undefined) delete process.env.CATALYST_HOST_NAME;
      else process.env.CATALYST_HOST_NAME = orig;
    }
  });

  test("fallback collapses os.hostname() FQDN to the first label (no dot in result)", () => {
    const orig = process.env.CATALYST_HOST_NAME;
    const origCfg = process.env.CATALYST_LAYER2_CONFIG_FILE;
    delete process.env.CATALYST_HOST_NAME;
    process.env.CATALYST_LAYER2_CONFIG_FILE = "/nonexistent/config.json";
    try {
      expect(getHostName()).not.toContain(".");
    } finally {
      if (orig === undefined) delete process.env.CATALYST_HOST_NAME;
      else process.env.CATALYST_HOST_NAME = orig;
      if (origCfg === undefined) delete process.env.CATALYST_LAYER2_CONFIG_FILE;
      else process.env.CATALYST_LAYER2_CONFIG_FILE = origCfg;
    }
  });
});
