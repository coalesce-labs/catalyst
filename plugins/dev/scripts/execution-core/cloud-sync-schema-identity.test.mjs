// cloud-sync-schema-identity.test.mjs — CTL-1869.
//
// Run: cd plugins/dev/scripts/execution-core && bun test cloud-sync-schema-identity.test.mjs

import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import {
  appendSchemaIdentity,
  createSchemaReportingWsFactory,
  replicaSchemaIdentity,
  schemaIdentityOf,
} from "./cloud-sync-schema-identity.mjs";

const CONNECT = "https://hub.example/connect?account=acme&token=SECRET";

// Resolve both candidate schema copies the way production does, independently of
// the module under test, so these are measurements rather than restatements.
const req = createRequire(import.meta.url);
const journalIdentity = (mod) => {
  const e = mod?.MIRROR_MIGRATIONS?.journal?.entries;
  return Array.isArray(e) ? { tail: e.at(-1)?.tag ?? null, count: e.length } : null;
};
const load = (fn) => {
  try {
    return fn();
  } catch {
    return null;
  }
};
const sdkSchema = load(() => createRequire(req.resolve("@catalyst-cloud/sdk/node"))("@catalyst-cloud/schema"));
const bareSchema = load(() => req("@catalyst-cloud/schema"));

describe("the reported identity is the bundle THE REPLICA APPLIES WITH", () => {
  test("equals the schema reached through the SDK entry cloud-sync.mjs imports", () => {
    // ⚠️ Asserted against an independently-computed measurement, not a literal, so
    // the test keeps its meaning across dependency bumps. The literal it replaced
    // ("0018_brainy_clint_barton", 19) pinned the WRONG copy — see below.
    expect(sdkSchema).not.toBeNull();
    const expected = journalIdentity(sdkSchema);
    expect(expected).not.toBeNull();
    expect(replicaSchemaIdentity()).toEqual(expected);
  });

  test("⭐ REGRESSION (Codex P1): it is NOT the bare/root-resolved copy", () => {
    // The defect: `import ... from "@catalyst-cloud/schema"` resolves from THIS
    // file, while the replica applies with whatever `@catalyst-cloud/sdk/node`
    // resolves. Under bun's isolated linker those are different copies — measured
    // on this checkout: replica-used 0.1.5 → 0015_brainy_lady_ursula/16, bare 0.1.9
    // → 0018_brainy_clint_barton/19. The shipped code advertised 19 for a replica
    // applying 16: three migrations behind, reported as CURRENT.
    const viaSdk = journalIdentity(sdkSchema);
    const viaBare = journalIdentity(bareSchema);
    if (!viaSdk || !viaBare) {
      // Do NOT pass quietly: a missing measurement is undiagnosable, and a green
      // light here would mean "could not look", not "correct".
      throw new Error(
        `INCONCLUSIVE: this tree does not expose two distinct schema copies ` +
          `(sdk=${JSON.stringify(viaSdk)} bare=${JSON.stringify(viaBare)}); ` +
          `the regression cannot be observed here.`
      );
    }

    if (viaSdk.tail === viaBare.tail) {
      // ⭐ A UNIFIED tree — and that is a RESULT, not an absence of evidence.
      // Once the SDK pin carries one exact schema through both `applyMigrations`
      // and replicate's `applyDelta`, there is only one copy, so "reported the bare
      // copy instead of the SDK's" is structurally unconstructible rather than
      // merely unobserved. Treating that as INCONCLUSIVE turned the FIX into a red
      // build (measured: this test failed CI on the 0.8.4 pin, whose whole purpose
      // is to produce this state).
      //
      // ⛔ But identical journal tails are NOT proof of one copy — two distinct
      // copies of the SAME version have identical tails, which is exactly the
      // "could not look" case this test refuses to green-light. So PROVE it: the
      // two resolutions must land on the same file on disk. If they don't, the
      // discrimination really was possible and something else silenced it.
      const realOf = (resolve) => {
        try {
          return realpathSync(resolve());
        } catch {
          return null;
        }
      };
      const sdkPath = realOf(() => createRequire(req.resolve("@catalyst-cloud/sdk/node")).resolve("@catalyst-cloud/schema"));
      const barePath = realOf(() => req.resolve("@catalyst-cloud/schema"));
      expect(sdkPath).not.toBeNull();
      expect(barePath).not.toBeNull();
      expect(sdkPath).toBe(barePath);
      // The invariant that still carries meaning in a unified tree: the reported
      // identity is the one the replica applies with.
      expect(replicaSchemaIdentity()).toEqual(viaSdk);
      return;
    }

    expect(replicaSchemaIdentity()).toEqual(viaSdk);
    expect(replicaSchemaIdentity().tail).not.toBe(viaBare.tail);
  });

  test("it is a migration tag from the loaded graph, not a version string", () => {
    // Upstream rationale worth pinning: a host ran schema 0.1.3 for 21+ days while
    // 0.1.5 was published and reported healthy throughout, because its replica tail
    // agreed with the INSTALLED bundle. A version string cannot answer "what did
    // this process load".
    const id = replicaSchemaIdentity();
    expect(typeof id.tail).toBe("string");
    expect(id.tail).toMatch(/^\d{4}_/);
  });
});

describe("schemaIdentityOf — works across schema versions", () => {
  const journalMod = (tags) => ({
    MIRROR_MIGRATIONS: { journal: { entries: tags.map((tag) => ({ tag })) } },
  });

  test("derives from the journal when the module has NO accessor (the 0.1.5 shape)", () => {
    // 0.1.5 — the copy the SDK actually resolves here — exports MIRROR_MIGRATIONS
    // but no `loadedSchemaIdentity`. Calling that accessor unconditionally is what
    // forced the bare import in the first place.
    expect(schemaIdentityOf(journalMod(["0001_a", "0002_b"]))).toEqual({ tail: "0002_b", count: 2 });
  });

  test("prefers the module's own accessor when it exposes one", () => {
    const mod = { ...journalMod(["0001_a"]), loadedSchemaIdentity: () => ({ tail: "0009_z", count: 9 }) };
    expect(schemaIdentityOf(mod)).toEqual({ tail: "0009_z", count: 9 });
  });

  test("a malformed accessor result falls through to the journal, not to unreported", () => {
    // "present but wrong" and "absent" are different verdicts; only the second is a
    // reason to give up on naming the bundle.
    const mod = { ...journalMod(["0001_a", "0002_b"]), loadedSchemaIdentity: () => ({ tail: 42 }) };
    expect(schemaIdentityOf(mod)).toEqual({ tail: "0002_b", count: 2 });
  });

  test("a throwing accessor falls through to the journal", () => {
    const mod = {
      ...journalMod(["0001_a"]),
      loadedSchemaIdentity: () => {
        throw new Error("boom");
      },
    };
    expect(schemaIdentityOf(mod)).toEqual({ tail: "0001_a", count: 1 });
  });

  test("unnameable input degrades to unreported, never a half-filled identity", () => {
    for (const bad of [null, undefined, {}, { MIRROR_MIGRATIONS: {} }, journalMod([])]) {
      expect(schemaIdentityOf(bad)).toEqual({ tail: null, count: 0 });
    }
  });
});

describe("replicaSchemaIdentity — fail-safe", () => {
  test("an unresolvable SDK yields unreported rather than throwing", () => {
    // This runs on the connect path of the daemon that keeps the replica alive; a
    // skew REPORT must never be able to prevent replication.
    expect(replicaSchemaIdentity({ sdkSpecifier: "@catalyst-cloud/does-not-exist" })).toEqual({
      tail: null,
      count: 0,
    });
  });

  test("a throwing resolver yields unreported", () => {
    const requireFn = {
      resolve() {
        throw new Error("resolution exploded");
      },
    };
    expect(replicaSchemaIdentity({ requireFn })).toEqual({ tail: null, count: 0 });
  });
});

describe("appendSchemaIdentity", () => {
  test("appends both params and preserves the existing query verbatim", () => {
    const out = new URL(appendSchemaIdentity(CONNECT, { tail: "0018_brainy_clint_barton", count: 19 }));
    expect(out.searchParams.get("schema_tail")).toBe("0018_brainy_clint_barton");
    expect(out.searchParams.get("schema_count")).toBe("19");
    // The connect URL carries auth; it must survive untouched.
    expect(out.searchParams.get("account")).toBe("acme");
    expect(out.searchParams.get("token")).toBe("SECRET");
  });

  test("⛔ ALL-OR-NOTHING: a null tail sends NEITHER param", () => {
    // A half-filled identity could be misread by the hub as `current`. The honest
    // degenerate state is `unreported`, so the URL is returned unmodified.
    for (const id of [{ tail: null, count: 0 }, { tail: undefined, count: 7 }, null, undefined]) {
      const out = appendSchemaIdentity(CONNECT, id);
      expect(out).toBe(CONNECT);
      expect(new URL(out).searchParams.has("schema_count")).toBe(false);
    }
  });

  test("percent-encodes a tail carrying URL-reserved characters", () => {
    // Why searchParams rather than string concatenation.
    const out = new URL(appendSchemaIdentity(CONNECT, { tail: "0018_a&b=c d", count: 19 }));
    expect(out.searchParams.get("schema_tail")).toBe("0018_a&b=c d"); // round-trips
    expect(out.toString()).not.toContain("0018_a&b=c d"); // ...but is encoded on the wire
  });
});

describe("createSchemaReportingWsFactory", () => {
  test("constructs the global WebSocket on the augmented URL", () => {
    const seen = [];
    const orig = globalThis.WebSocket;
    globalThis.WebSocket = class { constructor(url) { seen.push(url); } };
    try {
      createSchemaReportingWsFactory({ tail: "0018_brainy_clint_barton", count: 19 })(CONNECT);
    } finally { globalThis.WebSocket = orig; }
    expect(seen).toHaveLength(1);
    const u = new URL(seen[0]);
    expect(u.searchParams.get("schema_tail")).toBe("0018_brainy_clint_barton");
    expect(u.searchParams.get("schema_count")).toBe("19");
  });

  test("a degenerate identity still opens the socket, on the unmodified URL", () => {
    // The factory must never refuse to connect just because it has nothing to
    // report — reporting is observability, not a precondition for syncing.
    const seen = [];
    const orig = globalThis.WebSocket;
    globalThis.WebSocket = class { constructor(url) { seen.push(url); } };
    try {
      createSchemaReportingWsFactory({ tail: null, count: 0 })(CONNECT);
    } finally { globalThis.WebSocket = orig; }
    expect(seen).toEqual([CONNECT]);
  });

  test("throws a named error when no global WebSocket exists", () => {
    const orig = globalThis.WebSocket;
    // eslint-disable-next-line no-undef
    delete globalThis.WebSocket;
    try {
      expect(() => createSchemaReportingWsFactory({ tail: "0018_x", count: 1 })(CONNECT))
        .toThrow(/global WebSocket unavailable/);
    } finally { globalThis.WebSocket = orig; }
  });
});

describe("⚠️ the wiring: cloud-sync must actually pass the factory", () => {
  test("cloud-sync.mjs constructs the replica with wsFactory", async () => {
    // The feature is inert unless the factory reaches CatalystReplica — the whole
    // reason this port exists is that a correct sender lived in a package no host
    // runs. Deleting the `wsFactory:` line turns this red.
    const src = await Bun.file(new URL("./cloud-sync.mjs", import.meta.url)).text();
    const ctor = src.slice(src.indexOf("new CatalystReplica({"));
    const body = ctor.slice(0, ctor.indexOf("\n});"));
    expect(body.length).toBeGreaterThan(80); // fails closed if the ctor is restructured
    expect(body).toContain("wsFactory: createSchemaReportingWsFactory()");
  });
});
