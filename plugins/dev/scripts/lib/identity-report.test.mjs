// identity-report.test.mjs — CTL-2300.
//
// The four identities `check-project-setup.sh` reports on, and in particular the rung
// Codex's round-1 P1 named: the ENROLLED account lives in `~/.config/catalyst/cloud-sync.env`
// (written by catalyst-enrol.sh), a file sourced only by the supervised cloud-sync launcher
// and never by an interactive shell. Reading only `process.env` reported `unresolved` on
// every correctly enrolled host — a warning that always fires, which is worse than no
// warning at all.
//
// Lives in lib/ (not scripts/__tests__/) so `run-tests.sh`'s `bun test ../lib/*.test.mjs`
// glob and the workflow's lib/ working-directory pick it up alongside cloud-facts.test.mjs.
// Registered by name in .github/workflows/execution-core-tests.yml.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  accountEnvFilePaths,
  readAccountFromEnvFiles,
  resolveIdentities,
  resolveTenantAccount,
} from "../identity-report.mjs";

const ABSENT = join("/nonexistent-catalyst-identity", "config.json");

/** A readFile stub over an in-memory {path: contents} map; anything else throws, as fs does. */
const fakeRead = (files) => (p) => {
  if (!(p in files)) throw new Error(`ENOENT: ${p}`);
  return files[p];
};

describe("resolveTenantAccount — the enrolled account is found where enrolment puts it", () => {
  test("process env wins, and says so", () => {
    const r = resolveTenantAccount({
      env: { CATALYST_CLOUD_ACCOUNT: "tenant-9" },
      envFilePaths: [],
      readFile: fakeRead({}),
    });
    expect(r).toMatchObject({ ok: true, account: "tenant-9", source: "env" });
  });

  test("⭐ Codex P1: an enrolled host resolves from cloud-sync.env, with NOTHING in process env", () => {
    const path = "/home/.config/catalyst/cloud-sync.env";
    const r = resolveTenantAccount({
      env: {},
      envFilePaths: [path],
      readFile: fakeRead({
        [path]:
          "# Written by catalyst-enrol.sh (CTL-1985).\n" +
          "export CATALYST_CLOUD_TOKEN=ctc_acct_secret\n" +
          "export CATALYST_CLOUD_ACCOUNT=tenant-3\n" +
          "export CATALYST_CLOUD_BASE_URL=https://staging.catalystcloud.dev/api/v1\n",
      }),
    });
    expect(r.ok).toBe(true);
    expect(r.account).toBe("tenant-3");
    expect(r.source).toContain(path);
  });

  test("the file rung is a narrow SCAN, not a source — the token beside it is never executed", () => {
    // The account id is one line in a file that also carries this host's cloud token.
    // `source`-ing it to answer "which account?" would run arbitrary shell for the
    // privilege of reading one assignment.
    const path = "/home/.config/catalyst/cloud-sync.env";
    const r = resolveTenantAccount({
      env: {},
      envFilePaths: [path],
      readFile: fakeRead({
        [path]: "rm -rf /tmp/should-never-run\nCATALYST_CLOUD_ACCOUNT='tenant-7'\n",
      }),
    });
    expect(r.account).toBe("tenant-7");
  });

  test("quoting, a missing `export`, and a repeated assignment all behave like the shell", () => {
    const p = "/f";
    const read = (body) =>
      readAccountFromEnvFiles([p], fakeRead({ [p]: body }))?.account ?? null;
    expect(read('export CATALYST_CLOUD_ACCOUNT="tenant-1"\n')).toBe("tenant-1");
    expect(read("CATALYST_CLOUD_ACCOUNT=tenant-2\n")).toBe("tenant-2");
    expect(read("  export CATALYST_CLOUD_ACCOUNT = 'tenant-4' \n")).toBe("tenant-4");
    // last assignment wins, as it would after sourcing
    expect(read("CATALYST_CLOUD_ACCOUNT=a\nCATALYST_CLOUD_ACCOUNT=b\n")).toBe("b");
    // an empty assignment is not a declaration
    expect(read("CATALYST_CLOUD_ACCOUNT=\n")).toBe(null);
    // a look-alike var is not it
    expect(read("CATALYST_CLOUD_ACCOUNT_SOURCE=declared\n")).toBe(null);
  });

  test("files are tried in order; an absent one is skipped, not fatal", () => {
    const a = "/a.env";
    const b = "/b.env";
    expect(
      readAccountFromEnvFiles([a, b], fakeRead({ [b]: "CATALYST_CLOUD_ACCOUNT=from-b\n" }))?.account,
    ).toBe("from-b");
    expect(
      readAccountFromEnvFiles(
        [a, b],
        fakeRead({ [a]: "CATALYST_CLOUD_ACCOUNT=from-a\n", [b]: "CATALYST_CLOUD_ACCOUNT=from-b\n" }),
      )?.account,
    ).toBe("from-a");
  });

  test("⛔ an unenrolled host is UNRESOLVED, and never tenant-0", () => {
    const paths = accountEnvFilePaths({ HOME: "/tmp/h" });
    const r = resolveTenantAccount({ env: {}, envFilePaths: paths, readFile: fakeRead({}) });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("tenant-0"); // named as what it refuses to assume…
    expect(r.message).toContain(paths[0]); // …and where enrolment puts the real one
    expect(r).not.toHaveProperty("account");
  });

  test("the env-file paths come off HOME, so a test (or a container) can move them", () => {
    expect(accountEnvFilePaths({ HOME: "/tmp/h" })).toEqual([
      "/tmp/h/.config/catalyst/cloud-sync.env",
      "/tmp/h/.config/catalyst/cluster.env",
    ]);
  });
});

describe("resolveIdentities — one row per slot, and the report is exhaustive", () => {
  test("all four slots are always present, resolved or not", () => {
    const rows = resolveIdentities({
      env: {},
      layer1ConfigPath: ABSENT,
      layer2ConfigPath: ABSENT,
    });
    expect(rows.map((r) => r.slot)).toEqual(["tenant", "human", "team", "host"]);
    // Every row carries an actionable detail — an `unresolved` line with no detail would
    // be a warning the operator cannot act on.
    for (const row of rows) expect(row.detail.length).toBeGreaterThan(10);
  });

  test("⭐ host resolved from the DEFAULT rung is ok — the canonical host is an answer", () => {
    const host = resolveIdentities({
      env: {},
      layer1ConfigPath: ABSENT,
      layer2ConfigPath: ABSENT,
    }).find((r) => r.slot === "host");
    expect(host.ok).toBe(true);
    expect(host.detail).toContain("staging.catalystcloud.dev");
  });

  test("⛔ but a RETIRED host is not ok, and the row says where the canonical one goes", () => {
    const host = resolveIdentities({
      env: { CATALYST_CLOUD_BASE_URL: "https://api.catalyst-cloud.coalescelabs.ai/api/v1" },
      layer1ConfigPath: ABSENT,
      layer2ConfigPath: ABSENT,
    }).find((r) => r.slot === "host");
    expect(host.ok).toBe(false);
    expect(host.detail).toContain("catalyst.cloud.baseUrl");
  });
});
