// doctor-cloud-sync-skew.test.mjs — CTL-1659. Tests checkCloudSyncSkew() in doctor.mjs:
// the on-demand half of "a dependency fix that lands on main should reach running daemons".
//
// The load-bearing invariants, in the order they matter:
//   1. it can NEVER report PASS on absent or stale input (a check that cannot fail is
//      not evidence — the whole reason `restart_needed` went unnoticed for weeks);
//   2. it NEVER emits a FAIL record — it sits in the advisory checkCloudSync family,
//      whose FAIL count gates catalyst-join activation;
//   3. every deps is injected, so this suite touches no fs/ps/launchctl.
// Run: cd plugins/dev/scripts/execution-core && bun test doctor-cloud-sync-skew
import { describe, test, expect } from "bun:test";
import { checkCloudSyncSkew } from "../doctor.mjs";

const ROOT = "/opt/plugin-source";
const LOCK = `${ROOT}/bun.lock`;
const SDK_PKG = `${ROOT}/node_modules/@catalyst-cloud/sdk/package.json`;
const SDK_ENTRY = `${ROOT}/node_modules/@catalyst-cloud/sdk/dist/node.js`;
const SDK_ENTRY_BYTES = "// sdk entry bytes v1\n";
const LOCK_TEXT = `{
  "packages": {
    "@catalyst-cloud/sdk": ["@catalyst-cloud/sdk@0.8.2", "", {}, "sha512-aaa=="],
  }
}`;
const sha256 = (s) => "sha256:" + new Bun.CryptoHasher("sha256").update(s).digest("hex");
// The digest the writer would have recorded at boot for LOCK_TEXT above.
const BOOT_LOCK_HASH = sha256(LOCK_TEXT);
// …and for the ENTRY FILE it actually loaded. This fixture used to carry a placeholder
// `entryHash: "sha256:deadbeef"` with no corresponding file on the synthetic disk, which
// was harmless only because NO comparator read `entryHash` back — the round-2 defect. Now
// that the loaded-vs-locked link compares it, the healthy fixture has to supply the real
// bytes; a fixture that cannot present the discriminator cannot exercise the check.
const BOOT_ENTRY_HASH = sha256(SDK_ENTRY_BYTES);

function breadcrumb(over = {}) {
  return {
    ts: 1_800_000_000_000,
    pid: 4242,
    root: ROOT,
    lockPath: LOCK,
    lockHash: BOOT_LOCK_HASH,
    degraded: false,
    degradedReasons: [],
    packages: [
      {
        id: "@catalyst-cloud/sdk",
        specifier: "@catalyst-cloud/sdk/node",
        resolvedPath: SDK_ENTRY,
        packageJsonPath: SDK_PKG,
        version: "0.8.2",
        entryHash: BOOT_ENTRY_HASH,
      },
    ],
    ...over,
  };
}

function deps(over = {}) {
  const files = {
    [LOCK]: LOCK_TEXT,
    [SDK_PKG]: JSON.stringify({ name: "@catalyst-cloud/sdk", version: "0.8.2" }),
    [SDK_ENTRY]: SDK_ENTRY_BYTES,
    ...(over.files ?? {}),
  };
  delete over.files;
  return {
    agentInstalled: () => true,
    processAlive: () => true,
    depsPath: "/tmp/cloud-sync.deps.json",
    readBreadcrumb: () => breadcrumb(),
    readText: (p) => {
      if (!Object.prototype.hasOwnProperty.call(files, p)) throw new Error(`ENOENT ${p}`);
      return files[p];
    },
    readJson: (p) => {
      if (!Object.prototype.hasOwnProperty.call(files, p)) throw new Error(`ENOENT ${p}`);
      return JSON.parse(files[p]);
    },
    processCommandForPid: (pid) => (pid === 4242 ? "bun /opt/plugin-source/plugins/dev/scripts/execution-core/cloud-sync.mjs" : null),
    ...over,
  };
}

const one = (recs) => { expect(recs).toHaveLength(1); return recs[0]; };
const noFail = (recs) => recs.every((r) => r.status !== "fail");

describe("checkCloudSyncSkew", () => {
  test("healthy: boot record matches the current lockfile and the installed version → PASS", () => {
    const r = one(checkCloudSyncSkew(deps()));
    expect(r.name).toBe("cloud-sync-skew");
    expect(r.status).toBe("pass");
  });

  test("THE INCIDENT: the lockfile changed after the writer booted → WARN naming the restart", () => {
    const r = one(checkCloudSyncSkew(deps({ files: { [LOCK]: LOCK_TEXT.replace("0.8.2", "0.8.3") } })));
    expect(r.status).toBe("warn");
    expect(r.detail).toMatch(/lockfile|loaded/i);
    expect(r.detail).toMatch(/restart|kickstart/i);
  });

  test("installed-vs-locked drift NAMES the package and BOTH versions (the ticket's alert contract)", () => {
    const r = one(
      checkCloudSyncSkew(deps({ files: { [SDK_PKG]: JSON.stringify({ name: "@catalyst-cloud/sdk", version: "0.7.0" }) } })),
    );
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("@catalyst-cloud/sdk");
    expect(r.detail).toContain("0.7.0");
    expect(r.detail).toContain("0.8.2");
  });

  test("POSITIVE CONTROL — absent boot record can NEVER read as healthy", () => {
    const r = one(checkCloudSyncSkew(deps({ readBreadcrumb: () => null })));
    expect(r.status).toBe("warn");
    expect(r.status).not.toBe("pass");
    expect(r.detail).toMatch(/unknown|no boot record|absent/i);
  });

  test("POSITIVE CONTROL — a STALE boot record (pid is not the live writer) can never read as healthy", () => {
    const dead = one(checkCloudSyncSkew(deps({ processCommandForPid: () => null })));
    expect(dead.status).toBe("warn");
    const recycled = one(checkCloudSyncSkew(deps({ processCommandForPid: () => "/usr/bin/vim notes.txt" })));
    expect(recycled.status).toBe("warn");
    // Control: the SAME check DOES return pass when the pid genuinely names the writer.
    expect(one(checkCloudSyncSkew(deps())).status).toBe("pass");
  });

  test("a degraded boot record (a dep it could not resolve) is surfaced, never silently passed", () => {
    const r = one(
      checkCloudSyncSkew(deps({ readBreadcrumb: () => breadcrumb({ degraded: true, degradedReasons: ["@catalyst-cloud/sdk: Cannot find module"] }) })),
    );
    expect(r.status).toBe("warn");
    expect(r.detail).toMatch(/degraded|resolve/i);
  });

  test("writer not installed → single INFO (nothing is loaded, so nothing can be skewed)", () => {
    const r = one(checkCloudSyncSkew(deps({ agentInstalled: () => false, readBreadcrumb: () => null })));
    expect(r.status).toBe("info");
  });

  test("NEVER FAILs — every branch stays advisory (the catalyst-join gate is the FAIL count)", () => {
    const branches = [
      deps(),
      deps({ readBreadcrumb: () => null }),
      deps({ processCommandForPid: () => null }),
      deps({ agentInstalled: () => false }),
      deps({ files: { [LOCK]: "corrupt" } }),
      deps({ readText: () => { throw new Error("EIO"); } }),
      deps({ readBreadcrumb: () => { throw new Error("boom"); } }),
    ];
    for (const d of branches) expect(noFail(checkCloudSyncSkew(d))).toBe(true);
  });

  test("a throwing dependency degrades to WARN instead of crashing the whole doctor run", () => {
    const r = one(checkCloudSyncSkew(deps({ readBreadcrumb: () => { throw new Error("boom"); } })));
    expect(r.status).toBe("warn");
  });
});
