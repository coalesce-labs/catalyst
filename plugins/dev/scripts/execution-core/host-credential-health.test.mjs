// host-credential-health.test.mjs — CTL-2045 §3 (the doctor half).
//
// The acceptance criterion is a DRIFT case: "an already-provisioned host whose write
// credential is later replaced by an admin bearer … the check does NOT pass, and names
// the credential class it found."

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { checkHostWriteCredentialClass, extractExportedValue } from "./host-credential-health.mjs";

const ADMIN_BEARER = "0123456789012345678901234567890123456789012345678901234567890123";
const ORG_KEY = "ctc_acct_sk_fixture_testonly_000000000000000000000000000000";

const withEnvFile = (body, over = {}) =>
  checkHostWriteCredentialClass({
    envPath: "/seal/cloud-sync.env",
    exists: () => true,
    readFile: () => body,
    ...over,
  });

describe("checkHostWriteCredentialClass", () => {
  test("a per-host org key PASSES and reports the shape, never the value", () => {
    const c = withEnvFile(`export CATALYST_CLOUD_TOKEN=${ORG_KEY}\n`);
    expect(c.status).toBe("pass");
    expect(c.detail).toContain("ctc_acct_…");
    expect(c.detail).not.toContain(ORG_KEY);
  });

  // ⭐ THE ACCEPTANCE CRITERION. This is mini-2's 2026-08-18 state exactly.
  test("an admin bearer does NOT pass and names the class it found", () => {
    const c = withEnvFile(`export CATALYST_CLOUD_TOKEN=${ADMIN_BEARER}\n`);
    expect(c.status).not.toBe("pass");
    expect(c.detail).toContain("WRONG CREDENTIAL CLASS");
    expect(c.detail).toContain("no recognized prefix");
    expect(c.detail).toContain("ADMIN_TOKEN");
    // ⛔ The operator pastes this line into a thread. It must not carry the secret.
    expect(c.detail).not.toContain(ADMIN_BEARER);
  });

  test("advisory only — a wrong class never returns FAIL (doctor's FAIL count gates activation)", () => {
    for (const tok of [ADMIN_BEARER, "ctc_user_abc", "sk_fixture_abc", "tok_whatever"]) {
      const c = withEnvFile(`export CATALYST_CLOUD_TOKEN=${tok}\n`);
      expect(c.status).toBe("warn");
    }
  });

  test("a user key and a raw issuer key are each named distinctly, not lumped together", () => {
    expect(withEnvFile("export CATALYST_CLOUD_TOKEN=ctc_user_abc\n").detail).toContain("USER key");
    expect(withEnvFile("export CATALYST_CLOUD_TOKEN=sk_fixture_abc\n").detail).toContain(
      "RAW issuer key"
    );
  });

  // ⛔ THREE-VALUED. "I could not look" must never render as "it is fine".
  test("absent / unreadable / token-less files never PASS", () => {
    expect(checkHostWriteCredentialClass({ envPath: "/seal/x", exists: () => false }).status).toBe(
      "info"
    );
    const thrown = checkHostWriteCredentialClass({
      envPath: "/seal/x",
      exists: () => true,
      readFile: () => {
        throw new Error("EACCES");
      },
    });
    expect(thrown.status).toBe("warn");
    expect(thrown.detail).toContain("UNREADABLE");
    const noLine = withEnvFile("export CATALYST_CLOUD_ACCOUNT=tenant-0\n");
    expect(noLine.status).toBe("warn");
    expect(noLine.detail).toContain("no 'export CATALYST_CLOUD_TOKEN=' line");
  });

  test("honours a configured token env-var NAME (the writer resolves that name, not the default)", () => {
    const body = `export MY_TOKEN=${ADMIN_BEARER}\nexport CATALYST_CLOUD_TOKEN=${ORG_KEY}\n`;
    // Grading the DEFAULT name here would read the good key and report a healthy host
    // while the writer loads the admin bearer from MY_TOKEN.
    const c = withEnvFile(body, { tokenVar: "MY_TOKEN" });
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("WRONG CREDENTIAL CLASS");
  });

  test("an appended file is graded on the LAST assignment — the one the shell honours", () => {
    const body = `export CATALYST_CLOUD_TOKEN=${ORG_KEY}\nexport CATALYST_CLOUD_TOKEN=${ADMIN_BEARER}\n`;
    const c = withEnvFile(body);
    expect(c.status).toBe("warn");
  });

  // ⚠️ Every test above INJECTS every seam, so the zero-argument shape — the one the
  // doctor registry actually calls — is exercised by none of them. A check that throws
  // on its own defaults is a check that crashes doctor on every host.
  test("the ZERO-ARGUMENT call — the shape doctor's registry uses — does not throw", () => {
    expect(() => checkHostWriteCredentialClass()).not.toThrow();
    const c = checkHostWriteCredentialClass();
    expect(["pass", "warn", "info"]).toContain(c.status);
    expect(c.name).toBe("host-write-credential-class");
  });

  // Reads a real file off a real disk: the injected `readFile` above cannot catch a
  // path/encoding mistake in the default reader.
  test("reads a REAL file from disk end to end", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctl2045-"));
    const p = join(dir, "cloud-sync.env");
    writeFileSync(p, `export CATALYST_CLOUD_TOKEN=${ADMIN_BEARER}\n`, { mode: 0o600 });
    const c = checkHostWriteCredentialClass({ envPath: p });
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("WRONG CREDENTIAL CLASS");
  });
});

describe("extractExportedValue", () => {
  test("ignores a BARE assignment — launch.sh sources this file, so only exports reach bun", () => {
    expect(extractExportedValue("CATALYST_CLOUD_TOKEN=abc\n", "CATALYST_CLOUD_TOKEN")).toBeNull();
  });

  test("does not match a variable whose name merely CONTAINS the target", () => {
    expect(
      extractExportedValue("export NOT_CATALYST_CLOUD_TOKEN=abc\n", "CATALYST_CLOUD_TOKEN")
    ).toBeNull();
  });

  test("strips one layer of surrounding quotes", () => {
    expect(extractExportedValue(`export T="abc"\n`, "T")).toBe("abc");
    expect(extractExportedValue(`export T='abc'\n`, "T")).toBe("abc");
    expect(extractExportedValue(`export T=abc\n`, "T")).toBe("abc");
  });

  test("never executes the file — a command substitution is returned as literal text", () => {
    expect(extractExportedValue("export T=$(rm -rf /)\n", "T")).toBe("$(rm -rf /)");
  });
});
