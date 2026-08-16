// cloud-sync-account.test.mjs — CTL-1893 / sdk 0.8.7 replica tenant fence.
//
// Run: cd plugins/dev/scripts/execution-core && bun test cloud-sync-account.test.mjs

import { describe, expect, test } from "bun:test";
import {
  accountMismatchEnvelope,
  isAccountMismatchError,
  resolveAccountProvenance,
} from "./cloud-sync-account.mjs";

describe("⭐ provenance: a DECLARED account is a different fact from a DEFAULTED one", () => {
  test("an explicitly set env var is DECLARED", () => {
    const r = resolveAccountProvenance({ CATALYST_CLOUD_ACCOUNT: "tenant-3" });
    expect(r).toEqual({ account: "tenant-3", accountSource: "declared", declared: true });
  });

  test("unset falls back and is reported as DEFAULT", () => {
    const r = resolveAccountProvenance({});
    expect(r).toEqual({ account: "tenant-0", accountSource: "default", declared: false });
  });

  test("⛔ an EMPTY STRING is not a declaration", () => {
    // `CATALYST_CLOUD_ACCOUNT=""` is indistinguishable from unset in intent. Treating it
    // as declared would stamp a permanent assertion off a value nobody chose — the exact
    // failure this contract exists to prevent.
    const r = resolveAccountProvenance({ CATALYST_CLOUD_ACCOUNT: "" });
    expect(r.accountSource).toBe("default");
    expect(r.account).toBe("tenant-0");
  });

  test("the fallback account is injectable, not assumed", () => {
    expect(resolveAccountProvenance({}, "tenant-9").account).toBe("tenant-9");
  });

  test("a missing env object does not throw", () => {
    expect(resolveAccountProvenance(undefined, "t").account).toBe("t");
    expect(resolveAccountProvenance(null, "t").accountSource).toBe("default");
  });

  test("⭐ THE EDGE THE SDK NEEDS: declared is what makes the transition reachable", () => {
    // The SDK refuses when `mySource !== "declared"`. So a host reconfigured from the
    // default tenant to an explicit one is REFUSED unless we report provenance —
    // failing to start on the very reconfiguration the operator just performed.
    const reconfigured = resolveAccountProvenance({ CATALYST_CLOUD_ACCOUNT: "tenant-3" });
    expect(reconfigured.accountSource).toBe("declared"); // ← the transition edge
    const untouched = resolveAccountProvenance({});
    expect(untouched.accountSource).toBe("default"); // ← stays recoverable
  });
});

describe("⛔ the permanent-refusal discriminator matches by NAME, not instanceof", () => {
  test("the SDK's error is recognised", () => {
    const e = new Error("nope");
    e.name = "ReplicaAccountMismatchError";
    expect(isAccountMismatchError(e)).toBe(true);
  });

  test("a cross-copy error object still matches — which instanceof would not", () => {
    // The SDK can be present as more than one copy under the isolated linker; a
    // cross-copy `instanceof` is FALSE and would silently route a permanent config fault
    // back onto the retry-forever path. This is a plain object with the right name.
    expect(isAccountMismatchError({ name: "ReplicaAccountMismatchError" })).toBe(true);
  });

  test("ordinary start failures are NOT treated as permanent", () => {
    // These must keep exiting 1 so launchd retries: a second live writer, an unreachable
    // host, a seed failure. Misclassifying one as permanent parks the writer forever.
    for (const bad of [new Error("connect ECONNREFUSED"), { name: "TimeoutError" }, null, undefined, {}, "str"]) {
      expect(isAccountMismatchError(bad)).toBe(false);
    }
  });
});

describe("the refusal envelope", () => {
  const base = {
    host: "mini-2",
    dbPath: "/x/catalyst-replica.db",
    storedAccount: "tenant-0",
    configuredAccount: "tenant-3",
    configuredSource: "declared",
    ts: "2026-08-16T10:00:00Z",
    id: "abc",
    traceId: "t",
    spanId: "s",
    resource: { "service.name": "catalyst.cloud-sync" },
  };

  test("is ERROR severity — no restart clears this, so it is not a warning", () => {
    const e = accountMismatchEnvelope(base);
    expect(e.severityText).toBe("ERROR");
    expect(e.severityNumber).toBe(17);
  });

  test("carries both accounts and the provenance in ATTRIBUTES", () => {
    // otel-forward strips body.payload off-machine, so anything an alert must select on
    // has to live in attributes.
    const a = accountMismatchEnvelope(base).attributes;
    expect(a["event.name"]).toBe("catalyst.replica.account_mismatch");
    expect(a.stored_account).toBe("tenant-0");
    expect(a.configured_account).toBe("tenant-3");
    expect(a.configured_source).toBe("declared");
    expect(a.db_path).toBe("/x/catalyst-replica.db");
  });

  test("an unknown stored account is null and named, never blank", () => {
    const e = accountMismatchEnvelope({ ...base, storedAccount: undefined });
    expect(e.attributes.stored_account).toBeNull();
    expect(e.body.message).toContain("(unknown)");
  });

  test("the message states the consequence, not just the condition", () => {
    // An operator reading this at 3am needs to know the writer is DOWN and will stay down.
    expect(accountMismatchEnvelope(base).body.message).toContain("staying down");
  });
});

describe("⭐ Codex round 2 P1: the LAUNCHER defaults the account, erasing provenance", () => {
  // cloud-sync/launch.sh runs CATALYST_CLOUD_ACCOUNT="${CATALYST_CLOUD_ACCOUNT:-tenant-0}",
  // so on the shipped launchd path the var is ALWAYS set by the time the writer reads it.
  // Env-presence alone therefore reports "declared" for every host, stamping every default
  // replica with a declaration nobody made — permanently, since the stamp cannot be undone.
  test("⛔ presence-only would say declared; the explicit marker says default", () => {
    const launcherDefaulted = { CATALYST_CLOUD_ACCOUNT: "tenant-0", CATALYST_CLOUD_ACCOUNT_SOURCE: "default" };
    expect(resolveAccountProvenance(launcherDefaulted).accountSource).toBe("default");
    // and without the marker the old derivation is what would have gone wrong:
    expect(resolveAccountProvenance({ CATALYST_CLOUD_ACCOUNT: "tenant-0" }).accountSource).toBe("declared");
  });

  test("a genuine operator declaration still reports declared through the launcher", () => {
    const declared = { CATALYST_CLOUD_ACCOUNT: "tenant-3", CATALYST_CLOUD_ACCOUNT_SOURCE: "declared" };
    const r = resolveAccountProvenance(declared);
    expect(r).toEqual({ account: "tenant-3", accountSource: "declared", declared: true });
  });

  test("⛔ an UNRECOGNISED marker degrades to default, never to declared", () => {
    // A declared stamp is permanent and refuses later transitions; a default stamp stays
    // recoverable. An unknown value must land on the recoverable side.
    // ⚠️ These run with the ACCOUNT SET, i.e. the launchd path — where falling through to
    // presence-derivation would answer "declared" and re-open the bug. A present-but-
    // unreadable marker must therefore NOT fall through.
    for (const bad of ["DECLARED", "yes", "1", "true", "Default"]) {
      const r = resolveAccountProvenance({ CATALYST_CLOUD_ACCOUNT: "tenant-3", CATALYST_CLOUD_ACCOUNT_SOURCE: bad });
      expect(r.accountSource).toBe("default");
      expect(r.declared).toBe(false);
    }
    // absent / empty / non-string = no marker at all → presence-derivation is correct,
    // since a non-launcher caller may legitimately pass no marker.
    for (const absent of ["", null, undefined, {}, 0]) {
      const r = resolveAccountProvenance({ CATALYST_CLOUD_ACCOUNT: "tenant-3", CATALYST_CLOUD_ACCOUNT_SOURCE: absent });
      expect(r.accountSource).toBe("declared");
    }
  });

  test("with NO marker at all, presence-derivation still applies (non-launcher callers)", () => {
    expect(resolveAccountProvenance({ CATALYST_CLOUD_ACCOUNT: "tenant-3" }).accountSource).toBe("declared");
    expect(resolveAccountProvenance({}).accountSource).toBe("default");
  });
});
