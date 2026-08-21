// lease-authority-gate.test.mjs — CTL-1786 Phase 3.
// Run: cd plugins/dev/scripts/execution-core && bun test lease-authority-gate.test.mjs
//
// The off/shadow/enforce gate that selects the lease path, plus the runCli wiring that keeps every
// caller's {won,generation} contract intact. off = attachment CAS only (byte-identical to today);
// shadow = lease claim observed + telemetry, ATTACHMENT authoritative; enforce = lease authoritative.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEASE_AUTHORITY_MODES, resolveLeaseAuthorityMode } from "./config.mjs";
import {
  LEASE_WOULD_GRANT_EVENT,
  LEASE_WOULD_REFUSE_EVENT,
  buildLeaseClaimEvent,
} from "./lease-authority.mjs";
import { releaseViaLease, runCli } from "./cluster-claim.mjs";
import { fenceUrl } from "./cluster-claim.mjs";

// ── a hermetic fake ATTACHMENT TRANSPORT so off/shadow exercise the CAS without touching
// defaultTransport (which reads the ambient write-proxy env — not a thing a gate unit test should
// depend on). A fresh ticket has no fence → the soft-CAS write-then-readback WINS. ──
function makeFakeAttachmentTransport() {
  const store = new Map(); // ticket -> metadata
  return {
    resolveIssueId: (ticket) => `uuid-${ticket}`,
    readAttachments: (ticket) => {
      const md = store.get(ticket);
      return md ? [{ url: fenceUrl(ticket), metadata: md }] : [];
    },
    upsertAttachment: ({ ticket, url, metadata }) => {
      const tk = ticket ?? url.replace("catalyst://fence/", "");
      store.set(tk, metadata);
      return { success: true };
    },
  };
}

/** A lease client that records calls and returns a scripted claim outcome. */
function fakeLeaseClient(claimResult) {
  const calls = { claim: 0, entitle: 0, release: 0 };
  return {
    calls,
    client: {
      claim: () => {
        calls.claim += 1;
        if (typeof claimResult === "function") return claimResult();
        return claimResult;
      },
      entitle: () => {
        calls.entitle += 1;
        return { ok: true, entitlement: {} };
      },
      release: (args) => {
        calls.release += 1;
        calls.releaseArgs = args;
        return { released: true };
      },
    },
  };
}

/** A lease client that BLOWS UP if touched — proves a path made zero lease calls. */
const explodingLeaseClient = {
  claim: () => {
    throw new Error("lease client must not be called");
  },
  entitle: () => {
    throw new Error("lease client must not be called");
  },
};

async function capture(fn) {
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s) => {
    chunks.push(String(s));
    return true;
  };
  let code;
  try {
    code = await fn();
  } finally {
    process.stdout.write = orig;
  }
  const line = chunks.join("").trim().split("\n").filter(Boolean).pop();
  return { code, out: line ? JSON.parse(line) : null };
}

// ── mode ladder ──────────────────────────────────────────────────────────────
const ENV_KEYS = ["CATALYST_LEASE_AUTHORITY", "CATALYST_LAYER2_CONFIG_FILE", "CATALYST_DEPLOYMENT_MODE"];
let saved;
let tmp;
function layer2(obj) {
  const p = join(tmp, "config.json");
  writeFileSync(p, JSON.stringify(obj));
  process.env.CATALYST_LAYER2_CONFIG_FILE = p;
}
beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  tmp = mkdtempSync(join(tmpdir(), "ctl1786-gate-"));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.CATALYST_LAYER2_CONFIG_FILE = join(tmp, "absent.json");
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe("resolveLeaseAuthorityMode — the mode ladder", () => {
  test("the mode set is exactly the three house modes", () => {
    expect([...LEASE_AUTHORITY_MODES].sort()).toEqual(["enforce", "off", "shadow"]);
  });
  test("defaults to off with nothing configured", () => {
    expect(resolveLeaseAuthorityMode({})).toBe("off");
  });
  test("env wins: shadow / enforce / 0", () => {
    expect(resolveLeaseAuthorityMode({ CATALYST_LEASE_AUTHORITY: "shadow", CATALYST_DEPLOYMENT_MODE: "cluster" })).toBe("shadow");
    expect(resolveLeaseAuthorityMode({ CATALYST_LEASE_AUTHORITY: "enforce", CATALYST_DEPLOYMENT_MODE: "cluster" })).toBe("enforce");
    expect(resolveLeaseAuthorityMode({ CATALYST_LEASE_AUTHORITY: "0" })).toBe("off");
  });
  test("garbage env → off (containment direction)", () => {
    expect(resolveLeaseAuthorityMode({ CATALYST_LEASE_AUTHORITY: "yes-please" })).toBe("off");
  });
  test("Layer-2 mode is honored when env is unset", () => {
    layer2({ catalyst: { leaseAuthority: { mode: "shadow" } } });
    expect(resolveLeaseAuthorityMode({ CATALYST_DEPLOYMENT_MODE: "cluster" })).toBe("shadow");
  });
  test("env overrides Layer-2", () => {
    layer2({ catalyst: { leaseAuthority: { mode: "enforce" } } });
    expect(resolveLeaseAuthorityMode({ CATALYST_LEASE_AUTHORITY: "off" })).toBe("off");
  });
  test("deployment coherence: enforce degrades to off on single-host (no peers to exclude)", () => {
    expect(resolveLeaseAuthorityMode({ CATALYST_LEASE_AUTHORITY: "enforce", CATALYST_DEPLOYMENT_MODE: "single-host" })).toBe("off");
  });
  test("enforce stays enforce on cluster", () => {
    expect(resolveLeaseAuthorityMode({ CATALYST_LEASE_AUTHORITY: "enforce", CATALYST_DEPLOYMENT_MODE: "cluster" })).toBe("enforce");
  });
});

describe("runCli claim — the gate wiring", () => {
  test("off: attachment claimTicket runs, ZERO lease calls, existing contract unchanged", async () => {
    const { code, out } = await capture(() =>
      runCli(["claim", "CTL-1", "mini", "triage"], {
        transport: makeFakeAttachmentTransport(),
        leaseMode: "off",
        leaseClient: explodingLeaseClient,
      })
    );
    expect(code).toBe(0);
    expect(out).toMatchObject({ won: true, generation: 1 });
  });

  test("enforce: lease claim is authoritative; the attachment CAS is NOT consulted", async () => {
    const lease = fakeLeaseClient({ won: true, generation: 77 });
    const throwingTransport = {
      resolveIssueId: () => {
        throw new Error("attachment must not be consulted under enforce");
      },
      readAttachments: () => {
        throw new Error("attachment must not be consulted under enforce");
      },
      upsertAttachment: () => {
        throw new Error("attachment must not be consulted under enforce");
      },
    };
    const { code, out } = await capture(() =>
      runCli(["claim", "CTL-2", "mini", "implement"], {
        transport: throwingTransport,
        leaseMode: "enforce",
        leaseClient: lease.client,
      })
    );
    expect(code).toBe(0);
    expect(out).toEqual({ won: true, generation: 77 });
    expect(lease.calls.claim).toBe(1);
  });

  test("enforce: a lease_held loss → exit 0 {won:false} (a lost race, not a stall)", async () => {
    const lease = fakeLeaseClient({ won: false, refusal: "lease_held" });
    const { code, out } = await capture(() =>
      runCli(["claim", "CTL-2", "mini", "implement"], {
        transport: {},
        leaseMode: "enforce",
        leaseClient: lease.client,
      })
    );
    expect(code).toBe(0);
    expect(out).toMatchObject({ won: false });
  });

  test("shadow: lease claim IS called and telemetry emitted, but the ATTACHMENT verdict wins", async () => {
    const lease = fakeLeaseClient({ won: false, refusal: "lease_held" }); // lease says LOSE
    const events = [];
    const { code, out } = await capture(() =>
      runCli(["claim", "CTL-3", "mini", "implement"], {
        transport: makeFakeAttachmentTransport(), // fresh ticket → attachment claim WINS (won:true)
        leaseMode: "shadow",
        leaseClient: lease.client,
        appendLeaseEvent: (line) => events.push(JSON.parse(line)),
      })
    );
    expect(code).toBe(0);
    // Attachment is authoritative → won:true even though the lease refused.
    expect(out).toMatchObject({ won: true });
    // The lease was observed and a would-refuse telemetry event emitted.
    expect(lease.calls.claim).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0].attributes["event.name"]).toBe(`${LEASE_WOULD_REFUSE_EVENT}.CTL-3`);
  });

  test("shadow: a lease observation THROW never fails the dispatch (attachment still returns)", async () => {
    const boom = {
      claim: () => {
        throw new Error("cloud down");
      },
      entitle: () => ({ ok: true, entitlement: {} }),
    };
    const { code, out } = await capture(() =>
      runCli(["claim", "CTL-4", "mini", "implement"], {
        transport: makeFakeAttachmentTransport(),
        leaseMode: "shadow",
        leaseClient: boom,
        appendLeaseEvent: () => {},
      })
    );
    expect(code).toBe(0);
    expect(out).toMatchObject({ won: true });
  });
});

describe("buildLeaseClaimEvent — the shadow observation envelope", () => {
  test("a win → would-grant name with the ticket suffix + numeric generation in payload", () => {
    const line = buildLeaseClaimEvent({ ticket: "CTL-5", phase: "implement", node: "mini", won: true, generation: 9 });
    const e = JSON.parse(line);
    expect(e.attributes["event.name"]).toBe(`${LEASE_WOULD_GRANT_EVENT}.CTL-5`);
    expect(e.body.payload.generation).toBe(9);
    expect(e.body.payload.won).toBe(true);
  });
  test("a refusal → would-refuse name carrying the refusal reason", () => {
    const line = buildLeaseClaimEvent({ ticket: "CTL-5", phase: "implement", node: "mini", won: false, refusal: "lease_held" });
    const e = JSON.parse(line);
    expect(e.attributes["event.name"]).toBe(`${LEASE_WOULD_REFUSE_EVENT}.CTL-5`);
    expect(e.body.payload.refusal).toBe("lease_held");
  });
});

describe("releaseViaLease — hand the lease back", () => {
  test("calls client.release exactly once with the grant nonce", async () => {
    const lease = fakeLeaseClient({ won: true, generation: 1 });
    const r = await releaseViaLease({ ticket: "CTL-6", phase: "implement", holder: "mini", nonce: 42, client: lease.client });
    expect(r.released).toBe(true);
    expect(lease.calls.release).toBe(1);
    expect(lease.calls.releaseArgs).toEqual({ ticket: "CTL-6", phase: "implement", holder: "mini", nonce: 42 });
  });
  test("no nonce → no-op, no wire call (nothing to release)", async () => {
    const lease = fakeLeaseClient({ won: true, generation: 1 });
    const r = await releaseViaLease({ ticket: "CTL-6", phase: "implement", holder: "mini", nonce: null, client: lease.client });
    expect(r.skipped).toBe(true);
    expect(lease.calls.release).toBe(0);
  });
  test("a release throw is swallowed (best-effort — the lease expires at TTL regardless)", async () => {
    const client = {
      release: () => {
        throw new Error("cloud down");
      },
    };
    const r = await releaseViaLease({ ticket: "CTL-6", phase: "implement", holder: "mini", nonce: 42, client });
    expect(r.released).toBe(false);
    expect(r.skipped).toBe(false);
  });
});
