// deployment-mode-tunnel-gate.test.ts — CTL-1617 PR3.
//
// Covers the additional AND-gate on the smee webhook tunnel-start sites
// (server.ts, GitHub + Linear tunnels): a node whose deployment mode
// resolves to "cloud" must NOT open either tunnel (its event source is the
// future cloud SDK connection instead — design §2/§6); every other
// deployment mode — including the "single-host" default every host
// resolves today — must be a byte-for-byte no-op.
//
// Risk 7 (design §10) — "consumer-side inversion bugs": a consumer that
// reads `mode === "cloud"` to *skip* something must independently prove it
// never skips for single-host/cluster/default. That is the explicit focus
// of the "never skips" describe block below, not just the cloud-suppression
// case.
import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer } from "../server";

// Fake smee-client constructor — never opens a real network connection.
// Mirrors the `fakeFactory` convention used throughout server.test.ts.
function makeFakeFactory(): {
  factory: () => { start: () => Promise<unknown>; stop: () => Promise<void> };
  constructorCalls: () => number;
} {
  let calls = 0;
  return {
    factory: () => {
      calls++;
      return {
        start: () => Promise.resolve({}),
        stop: () => Promise.resolve(),
      };
    },
    constructorCalls: () => calls,
  };
}

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    try {
      fn?.();
    } catch {
      /* ignore */
    }
  }
});

function makeWtDir(prefix: string): string {
  const tmp = mkdtempSync(join(tmpdir(), prefix));
  const wtDir = join(tmp, "wt");
  mkdirSync(wtDir, { recursive: true });
  cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));
  return wtDir;
}

async function settle(ms = 30): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe("CTL-1617 deployment-mode gate — never skips for single-host/cluster/default", () => {
  // This is the explicit inversion-bug guard the design mandates (§10 risk
  // 7): prove the gate does NOT suppress tunnel startup for every mode other
  // than "cloud", not just that it suppresses "cloud".
  for (const mode of ["single-host", "cluster"] as const) {
    it(`starts the GitHub tunnel when deployment mode resolves "${mode}"`, async () => {
      const wtDir = makeWtDir(`dm-gate-gh-${mode}-`);
      const srv = createServer({
        port: 0,
        wtDir,
        startWatcher: false,
        webhookConfig: {
          smeeChannel: "https://smee.io/test",
          secret: "s3cr3t",
          tunnelFactory: () => ({
            start: () => Promise.resolve({}),
            stop: () => Promise.resolve(),
          }),
        },
        deploymentModeReader: () => mode,
      });
      cleanups.push(() => void srv.stop(true));
      await settle();

      const res = await fetch(
        `http://localhost:${srv.port}/api/status/webhook-tunnel`,
      );
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.connected).toBe(true);
    });

    it(`starts the Linear tunnel when deployment mode resolves "${mode}"`, async () => {
      const wtDir = makeWtDir(`dm-gate-linear-${mode}-`);
      const { factory, constructorCalls } = makeFakeFactory();
      const srv = createServer({
        port: 0,
        wtDir,
        startWatcher: false,
        linearWebhookConfig: {
          linearSecrets: [{ key: "test", secret: "linear-test-secret" }],
          smeeChannel: "https://smee.io/linear-test",
          tunnelFactory: factory,
        },
        deploymentModeReader: () => mode,
      });
      cleanups.push(() => void srv.stop(true));
      await settle();

      expect(constructorCalls()).toBe(1);
    });
  }

  it("starts the GitHub tunnel when deployment mode is unset (real resolver, inferred default)", async () => {
    // No deploymentModeReader injected at all — exercises the PRODUCTION
    // wiring (`deploymentModeReaderOpt ?? getDeploymentMode`) end-to-end
    // against the real resolver, not a stub. Isolated from the real
    // environment/config files so the resolution deterministically falls
    // through every layer to the constant "single-host" default.
    const prevEnv = process.env.CATALYST_DEPLOYMENT_MODE;
    const prevL1 = process.env.CATALYST_CONFIG_FILE;
    const prevL2 = process.env.CATALYST_LAYER2_CONFIG_FILE;
    delete process.env.CATALYST_DEPLOYMENT_MODE;
    const tmp = mkdtempSync(join(tmpdir(), "dm-gate-default-"));
    process.env.CATALYST_CONFIG_FILE = join(tmp, "does-not-exist.json");
    process.env.CATALYST_LAYER2_CONFIG_FILE = join(
      tmp,
      "also-does-not-exist.json",
    );
    cleanups.push(() => {
      if (prevEnv === undefined) delete process.env.CATALYST_DEPLOYMENT_MODE;
      else process.env.CATALYST_DEPLOYMENT_MODE = prevEnv;
      if (prevL1 === undefined) delete process.env.CATALYST_CONFIG_FILE;
      else process.env.CATALYST_CONFIG_FILE = prevL1;
      if (prevL2 === undefined) delete process.env.CATALYST_LAYER2_CONFIG_FILE;
      else process.env.CATALYST_LAYER2_CONFIG_FILE = prevL2;
      rmSync(tmp, { recursive: true, force: true });
    });

    const wtDir = makeWtDir("dm-gate-default-wt-");
    const srv = createServer({
      port: 0,
      wtDir,
      startWatcher: false,
      webhookConfig: {
        smeeChannel: "https://smee.io/test",
        secret: "s3cr3t",
        tunnelFactory: () => ({
          start: () => Promise.resolve({}),
          stop: () => Promise.resolve(),
        }),
      },
      // deploymentModeReader intentionally omitted.
    });
    cleanups.push(() => void srv.stop(true));
    await settle();

    const res = await fetch(
      `http://localhost:${srv.port}/api/status/webhook-tunnel`,
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.connected).toBe(true);
  });
});

describe("CTL-1617 deployment-mode gate — cloud suppression", () => {
  it('does NOT start the GitHub tunnel when deployment mode resolves "cloud", and logs the suppression', async () => {
    const wtDir = makeWtDir("dm-gate-gh-cloud-");
    let constructorCalls = 0;
    const infoLogs: unknown[][] = [];
    const realInfo = console.info;
    console.info = (...args: unknown[]) => {
      infoLogs.push(args);
    };
    cleanups.push(() => {
      console.info = realInfo;
    });

    const srv = createServer({
      port: 0,
      wtDir,
      startWatcher: false,
      webhookConfig: {
        smeeChannel: "https://smee.io/test",
        secret: "s3cr3t",
        tunnelFactory: () => {
          constructorCalls++;
          return { start: () => Promise.resolve({}), stop: () => Promise.resolve() };
        },
      },
      deploymentModeReader: () => "cloud",
    });
    cleanups.push(() => void srv.stop(true));
    await settle();

    // Never even constructs the smee client — the gate short-circuits
    // before createWebhookTunnel() is called.
    expect(constructorCalls).toBe(0);

    const res = await fetch(
      `http://localhost:${srv.port}/api/status/webhook-tunnel`,
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.connected).toBe(false);

    expect(
      infoLogs.some(
        (args) =>
          String(args[0]).includes("suppressing") &&
          String(args[0]).includes("GitHub") &&
          String(args[0]).toLowerCase().includes("cloud"),
      ),
    ).toBe(true);
  });

  it('does NOT start the Linear tunnel when deployment mode resolves "cloud", and logs the suppression', async () => {
    const wtDir = makeWtDir("dm-gate-linear-cloud-");
    const { factory, constructorCalls } = makeFakeFactory();
    const infoLogs: unknown[][] = [];
    const realInfo = console.info;
    console.info = (...args: unknown[]) => {
      infoLogs.push(args);
    };
    cleanups.push(() => {
      console.info = realInfo;
    });

    const srv = createServer({
      port: 0,
      wtDir,
      startWatcher: false,
      linearWebhookConfig: {
        linearSecrets: [{ key: "test", secret: "linear-test-secret" }],
        smeeChannel: "https://smee.io/linear-test",
        tunnelFactory: factory,
      },
      deploymentModeReader: () => "cloud",
    });
    cleanups.push(() => void srv.stop(true));
    await settle();

    expect(constructorCalls()).toBe(0);
    expect(
      infoLogs.some(
        (args) =>
          String(args[0]).includes("suppressing") &&
          String(args[0]).includes("Linear") &&
          String(args[0]).toLowerCase().includes("cloud"),
      ),
    ).toBe(true);
  });

  it("suppresses both tunnels off a SINGLE deployment-mode resolution (reader called once)", async () => {
    // Design §6: "Resolved ONCE here (not per-tunnel) so both gates agree
    // within a single startup." Prove the reader isn't re-invoked per tunnel
    // (which could observe a torn read on a live-reloading file source).
    const wtDir = makeWtDir("dm-gate-single-resolve-");
    let readerCalls = 0;
    const srv = createServer({
      port: 0,
      wtDir,
      startWatcher: false,
      webhookConfig: {
        smeeChannel: "https://smee.io/test",
        secret: "s3cr3t",
        tunnelFactory: () => ({
          start: () => Promise.resolve({}),
          stop: () => Promise.resolve(),
        }),
      },
      linearWebhookConfig: {
        linearSecrets: [{ key: "test", secret: "linear-test-secret" }],
        smeeChannel: "https://smee.io/linear-test",
        tunnelFactory: () => ({
          start: () => Promise.resolve({}),
          stop: () => Promise.resolve(),
        }),
      },
      deploymentModeReader: () => {
        readerCalls++;
        return "cloud";
      },
    });
    cleanups.push(() => void srv.stop(true));
    await settle();

    expect(readerCalls).toBe(1);
  });
});
