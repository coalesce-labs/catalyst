// host-identity.test.ts — tests for hostName() / hostId() in canonical-event-shared.ts
// Run: cd plugins/dev/scripts/orch-monitor && bun test host-identity

import { describe, test, expect } from "bun:test";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostName, hostId, sha256Hex } from "../lib/canonical-event-shared";

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

  test("explicit override wins over CATALYST_HOST_NAME env", () => {
    const orig = process.env.CATALYST_HOST_NAME;
    process.env.CATALYST_HOST_NAME = "env-alias";
    try {
      expect(hostName({ raw: "my-mac.local", override: "explicit" })).toBe("explicit");
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

  test("strips a non-.local domain suffix (mini.rozich → mini)", () => {
    expect(hostName({ raw: "mini.rozich" })).toBe("mini");
  });

  test("strips multi-label FQDN to the first label", () => {
    expect(hostName({ raw: "host.with.many.dots" })).toBe("host");
  });

  test("explicit override with a dot is returned verbatim (not truncated)", () => {
    expect(hostName({ raw: "mini.rozich", override: "alias.one" })).toBe("alias.one");
  });

  test("CATALYST_HOST_NAME with a dot is returned verbatim", () => {
    const orig = process.env.CATALYST_HOST_NAME;
    process.env.CATALYST_HOST_NAME = "alias.one";
    try {
      expect(hostName({ raw: "mini.rozich" })).toBe("alias.one");
    } finally {
      if (orig === undefined) delete process.env.CATALYST_HOST_NAME;
      else process.env.CATALYST_HOST_NAME = orig;
    }
  });
});

function withLayer2(name: string, fn: () => void) {
  const dir = mkdtempSync(join(tmpdir(), "ctl1202-"));
  const cfg = join(dir, "config.json");
  writeFileSync(cfg, JSON.stringify({ catalyst: { host: { name } } }));
  const origCfg = process.env.CATALYST_LAYER2_CONFIG_FILE;
  const origEnv = process.env.CATALYST_HOST_NAME;
  delete process.env.CATALYST_HOST_NAME;
  process.env.CATALYST_LAYER2_CONFIG_FILE = cfg;
  try { return fn(); } finally {
    if (origCfg === undefined) delete process.env.CATALYST_LAYER2_CONFIG_FILE;
    else process.env.CATALYST_LAYER2_CONFIG_FILE = origCfg;
    // Always restore CATALYST_HOST_NAME to pre-withLayer2 state (fn may have set it)
    if (origEnv === undefined) delete process.env.CATALYST_HOST_NAME;
    else process.env.CATALYST_HOST_NAME = origEnv;
  }
}

describe("Layer-2 config fallback", () => {
  test("Layer-2 catalyst.host.name is used when env unset", () => {
    withLayer2("mini", () => expect(hostName()).toBe("mini"));
  });
  test("env var wins over Layer-2 config", () => {
    withLayer2("mini", () => {
      process.env.CATALYST_HOST_NAME = "env-alias";
      expect(hostName()).toBe("env-alias");
    });
  });
  test("explicit raw injection bypasses Layer-2 config read", () => {
    withLayer2("mini", () => expect(hostName({ raw: "injected.local" })).toBe("injected"));
  });
  test("missing/malformed Layer-2 file falls through to os.hostname()", () => {
    const orig = process.env.CATALYST_LAYER2_CONFIG_FILE;
    const origEnv = process.env.CATALYST_HOST_NAME;
    delete process.env.CATALYST_HOST_NAME;
    process.env.CATALYST_LAYER2_CONFIG_FILE = "/nonexistent/path/config.json";
    try { expect(hostName().length).toBeGreaterThan(0); }
    finally {
      if (orig === undefined) delete process.env.CATALYST_LAYER2_CONFIG_FILE;
      else process.env.CATALYST_LAYER2_CONFIG_FILE = orig;
      if (origEnv !== undefined) process.env.CATALYST_HOST_NAME = origEnv;
    }
  });
  test("hostId reflects Layer-2 name", () => {
    withLayer2("mini", () => expect(hostId()).toBe(sha256Hex("mini").slice(0, 16)));
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
