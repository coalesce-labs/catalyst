// github-feed-tunnel-gate.test.ts — CTL-1929.
//
// The GitHub smee tunnel must not open on a host whose cloud feed is AUTHORITATIVE
// (`CATALYST_GITHUB_FEED=enforce`) — the feed drives `github.*` dispatch and the
// broker's gate suppresses the smee copy for the names it covers, so a live tunnel
// there is a second delivery of events already being delivered.
//
// ⛔ THE INVERSION GUARD IS THE POINT, exactly as CTL-1617's sibling gate documents
// (design §10 risk 7): a consumer that reads a mode to SKIP something must
// independently prove it never skips for the other values. `shadow` is the
// dangerous one — it looks healthy and suppresses nothing, so closing the tunnel
// there would take GitHub ingestion to ZERO on a host that only meant to observe.
import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer } from "../server";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    try { fn?.(); } catch { /* ignore */ }
  }
});

function makeWtDir(prefix: string): string {
  const tmp = mkdtempSync(join(tmpdir(), prefix));
  const wtDir = join(tmp, "wt");
  mkdirSync(wtDir, { recursive: true });
  cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));
  return wtDir;
}

const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

function makeFakeFactory(): {
  factory: () => { start: () => Promise<unknown>; stop: () => Promise<void> };
  constructorCalls: () => number;
} {
  let calls = 0;
  return {
    factory: () => {
      calls++;
      return { start: () => Promise.resolve({}), stop: () => Promise.resolve() };
    },
    constructorCalls: () => calls,
  };
}

async function startGithub(prefix: string, authoritative: boolean | null) {
  const wtDir = makeWtDir(prefix);
  const { factory, constructorCalls } = makeFakeFactory();
  const srv = createServer({
    port: 0,
    wtDir,
    startWatcher: false,
    webhookConfig: {
      smeeChannel: "https://smee.io/gh-feed-gate-test",
      secret: "s3cr3t",
      tunnelFactory: factory,
    },
    // Pin deployment mode away from "cloud" so THIS gate is the only thing that
    // could suppress the tunnel — otherwise a pass would prove nothing about it.
    deploymentModeReader: () => "single-host",
    githubFeedAuthoritativeReader: authoritative === null ? null : () => authoritative,
  });
  cleanups.push(() => void srv.stop(true));
  await settle();
  return { srv, constructorCalls };
}

describe("⛔ the GitHub tunnel does not open when the cloud feed is authoritative", () => {
  it("feed AUTHORITATIVE (enforce) → no tunnel is constructed", async () => {
    const { constructorCalls } = await startGithub("gh-feed-gate-on-", true);
    expect(constructorCalls()).toBe(0);
  });
});

describe("⛔ inversion guard — it never skips for anything else", () => {
  it("⚠️ feed NOT authoritative (shadow/off) → the tunnel DOES open", async () => {
    // The failure this guards: widening the gate to `mode !== "off"` would close the
    // tunnel in shadow, where the producer emits nothing authoritative and the
    // dispatch gate suppresses nothing — GitHub ingestion would drop to zero on a
    // host that only meant to observe, and the parity ledger would then be comparing
    // the feed against an empty smee stream and reporting agreement.
    const { constructorCalls } = await startGithub("gh-feed-gate-off-", false);
    expect(constructorCalls()).toBe(1);
  });

  it("no reader injected (production wiring, feed unset) → the tunnel DOES open", async () => {
    // Exercises `githubFeedAuthoritativeReaderOpt ?? githubFeedIsAuthoritative`
    // against the REAL resolver rather than a stub. With CATALYST_GITHUB_FEED unset
    // in the test process the real answer is `off`, so this asserts the production
    // default is non-suppressing — the byte-for-byte no-op every host gets today.
    const saved = process.env.CATALYST_GITHUB_FEED;
    delete process.env.CATALYST_GITHUB_FEED;
    try {
      const { constructorCalls } = await startGithub("gh-feed-gate-real-", null);
      expect(constructorCalls()).toBe(1);
    } finally {
      if (saved === undefined) delete process.env.CATALYST_GITHUB_FEED;
      else process.env.CATALYST_GITHUB_FEED = saved;
    }
  });
});

describe("⛔ it gates the GITHUB tunnel ONLY — the Linear leg retired on its own terms", () => {
  it("an authoritative GitHub feed does not touch the Linear tunnel", async () => {
    // The two legs have separate knobs and separate rollouts by design; CTL-1928
    // retired Linear's tunnel already. A gate that closed both would couple two
    // cutovers that were deliberately decoupled — and would silently undo whatever
    // state the Linear leg is in on a host being cut over for GitHub.
    const wtDir = makeWtDir("gh-feed-gate-linear-");
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
      deploymentModeReader: () => "single-host",
      githubFeedAuthoritativeReader: () => true,
    });
    cleanups.push(() => void srv.stop(true));
    await settle();
    expect(constructorCalls()).toBe(1);
  });
});
