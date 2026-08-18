// replica-path.test.mjs — CTL-1893 increment 1.
//
// The resolver is a pure function over (account, env), so every case here is a
// table row. Two rows are CONTROLS and are labelled as such:
//
//   * the POSITIVE CONTROL the ticket asks for ("the defect is observable") —
//     today's account-blind resolver gives two distinct accounts the SAME path.
//     It is written against a local re-implementation of the OLD rule, so it
//     keeps asserting the defect exists after the new resolver replaces it.
//   * the NAMED-FAILURE control — an absent account must never silently become
//     tenant-0. This is the one the AC calls out, and it is the rule that makes
//     a mis-wired caller loud instead of plausible.
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_ACCOUNT,
  isAccountName,
  overrideDisagrees,
  resolveReplicaPath,
} from "./replica-path.mjs";

const ENV = (over) => ({ CATALYST_DIR: "/c", ...over });

describe("resolveReplicaPath — derivation", () => {
  test("the DEFAULT account keeps the legacy path (no host moves on upgrade)", () => {
    const r = resolveReplicaPath({ account: DEFAULT_ACCOUNT, env: ENV() });
    expect(r.ok).toBe(true);
    expect(r.path).toBe("/c/catalyst-replica.db");
    expect(r.source).toBe("derived-default");
  });

  test("a NON-default account derives its own file", () => {
    const r = resolveReplicaPath({ account: "tenant-7", env: ENV() });
    expect(r.ok).toBe(true);
    expect(r.path).toBe("/c/replicas/tenant-7.db");
    expect(r.source).toBe("derived");
  });

  test("two accounts on one host resolve to DIFFERENT paths (the fix)", () => {
    const a = resolveReplicaPath({ account: DEFAULT_ACCOUNT, env: ENV() });
    const b = resolveReplicaPath({ account: "tenant-7", env: ENV() });
    expect(a.path).not.toBe(b.path);
  });

  test("CATALYST_DIR absent falls back to $HOME/catalyst, matching getReplicaDbPath", () => {
    const r = resolveReplicaPath({
      account: DEFAULT_ACCOUNT,
      env: { HOME: "/h" },
    });
    expect(r.path).toBe("/h/catalyst/catalyst-replica.db");
  });
});

describe("resolveReplicaPath — named failures (never a silent default)", () => {
  // NAMED-FAILURE CONTROL: the AC's "a caller naming no account gets a named
  // failure, never a silent default to tenant-0".
  test.each([undefined, null, "", "   "])("account %p is account-absent, and yields NO path", (account) => {
    const r = resolveReplicaPath({ account, env: ENV() });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("account-absent");
    expect(r.path).toBeUndefined();
    expect(r.message).toMatch(/account/i);
  });

  test.each(["../etc", "a/b", "/abs", "..", "te nant", "a b"])(
    "account %p is account-invalid (separators and traversal cannot reach the filesystem)",
    (account) => {
      const r = resolveReplicaPath({ account, env: ENV() });
      expect(r.ok).toBe(false);
      expect(r.reason).toBe("account-invalid");
      expect(r.path).toBeUndefined();
    },
  );

  test("a backslash is rejected too (Windows-style separator)", () => {
    const r = resolveReplicaPath({ account: String.raw`a\b`, env: ENV() });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("account-invalid");
  });

  test("a non-string account is a named failure, not a coercion", () => {
    for (const account of [42, {}, [], true]) {
      const r = resolveReplicaPath({ account, env: ENV() });
      expect(r.ok).toBe(false);
      expect(r.reason).toBe("account-absent");
    }
  });

  test("isAccountName accepts the real fleet account and rejects traversal", () => {
    expect(isAccountName("tenant-0")).toBe(true);
    expect(isAccountName("acme_corp.eu-1")).toBe(true);
    expect(isAccountName("../x")).toBe(false);
    expect(isAccountName("-lead-dash")).toBe(false);
  });
});

describe("resolveReplicaPath — CATALYST_REPLICA_DB override", () => {
  test("override is HONOURED (test redirection and operator intent both keep working)", () => {
    const r = resolveReplicaPath({
      account: DEFAULT_ACCOUNT,
      env: ENV({ CATALYST_REPLICA_DB: "/tmp/x.db" }),
    });
    expect(r.ok).toBe(true);
    expect(r.path).toBe("/tmp/x.db");
    expect(r.source).toBe("override");
  });

  test("an override that DISAGREES with the derived path is reported, not hidden", () => {
    const r = resolveReplicaPath({
      account: "tenant-7",
      env: ENV({ CATALYST_REPLICA_DB: "/tmp/x.db" }),
    });
    expect(r.ok).toBe(true);
    expect(r.overrideDisagrees).toBe(true);
    expect(r.derived).toBe("/c/replicas/tenant-7.db");
  });

  test("an override that AGREES is not reported as a disagreement", () => {
    const r = resolveReplicaPath({
      account: "tenant-7",
      env: ENV({ CATALYST_REPLICA_DB: "/c/replicas/tenant-7.db" }),
    });
    expect(r.overrideDisagrees).toBe(false);
    expect(r.source).toBe("override-agrees");
  });

  test("an EMPTY override is not an override (empty string is not a declaration)", () => {
    const r = resolveReplicaPath({
      account: DEFAULT_ACCOUNT,
      env: ENV({ CATALYST_REPLICA_DB: "" }),
    });
    expect(r.source).toBe("derived-default");
    expect(r.path).toBe("/c/catalyst-replica.db");
  });

  test("overrideDisagrees() is the refusal predicate a writer will gate on", () => {
    const bad = resolveReplicaPath({
      account: "tenant-7",
      env: ENV({ CATALYST_REPLICA_DB: "/tmp/x.db" }),
    });
    expect(overrideDisagrees(bad)).toBe(true);
    expect(overrideDisagrees(resolveReplicaPath({ account: "tenant-7", env: ENV() }))).toBe(false);
    // A named failure is NOT a disagreement — the caller must handle it as its own case.
    expect(overrideDisagrees(resolveReplicaPath({ account: "", env: ENV() }))).toBe(false);
  });
});

describe("POSITIVE CONTROL — the defect this ticket exists to fix is observable", () => {
  // The old rule, re-implemented locally so it survives the resolver replacing it.
  // `cloud-sync.mjs:268` is `const dbPath = getReplicaDbPath()`, and
  // `getReplicaDbPath()` is `CATALYST_REPLICA_DB || <catalystDir>/catalyst-replica.db`
  // — no account dimension anywhere.
  const oldRule = (_account, env) =>
    env.CATALYST_REPLICA_DB || `${env.CATALYST_DIR}/catalyst-replica.db`;

  test("account-blind resolution gives two DIFFERENT accounts the SAME file", () => {
    expect(oldRule("tenant-0", ENV())).toBe(oldRule("tenant-7", ENV()));
  });

  test("...and the new resolver does not", () => {
    expect(resolveReplicaPath({ account: "tenant-0", env: ENV() }).path).not.toBe(
      resolveReplicaPath({ account: "tenant-7", env: ENV() }).path,
    );
  });
});
