// cloud-sync-schema-identity.test.mjs — CTL-1869.
//
// Run: cd plugins/dev/scripts/execution-core && bun test cloud-sync-schema-identity.test.mjs

import { describe, expect, test } from "bun:test";
import { appendSchemaIdentity, createSchemaReportingWsFactory } from "./cloud-sync-schema-identity.mjs";
import { loadedSchemaIdentity } from "@catalyst-cloud/schema";

const CONNECT = "https://hub.example/connect?account=acme&token=SECRET";

describe("the reported identity is the LOADED bundle's", () => {
  test("reports the concrete measured pair, not merely something non-null", () => {
    // ⚠️ Asserted as a CONCRETE pair on purpose. A test that accepts any non-null
    // value passes while reporting nonsense — which is the exact failure this
    // feature exists to detect, and the shape of the acceptance criterion I first
    // wrote for this ticket (a bare `0015` that could never have matched, since
    // `tail` is a migration TAG, not a number tracking the semver).
    const id = loadedSchemaIdentity();
    expect(id).toMatchObject({ tail: "0018_brainy_clint_barton", count: 19 });
  });

  test("it comes from the loaded module graph, not a version string", () => {
    // The upstream rationale, worth pinning: a host ran schema 0.1.3 for 21+ days
    // while 0.1.5 was published and reported healthy throughout, because its
    // replica tail agreed with the INSTALLED bundle. A version string cannot answer
    // "what did this process load".
    const id = loadedSchemaIdentity();
    expect(typeof id.tail).toBe("string");
    expect(id.tail).toMatch(/^\d{4}_/); // a migration tag, not a semver
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
