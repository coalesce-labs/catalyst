import { describe, test, expect } from "bun:test";
import { fingerprintLinearActor, readLinearActorFingerprint } from "./linear-actor-fingerprint.mjs";

describe("Linear actor fingerprints", () => {
  test("is deterministic, truncated, and never returns the raw id", () => {
    const fp = fingerprintLinearActor("client-id-secretish");
    expect(fp).toHaveLength(16);
    expect(fp).toBe(fingerprintLinearActor("client-id-secretish"));
    expect(fp).not.toContain("client-id-secretish");
  });
  test("reads only the orchestrator client id and fails open", () => {
    const cfg = JSON.stringify({ catalyst: { linear: { bot: { orchestrator: { clientId: "abc", clientSecret: "never-log" } } } } });
    expect(readLinearActorFingerprint("/virtual", { readFile: () => cfg })).toBe(fingerprintLinearActor("abc"));
    expect(readLinearActorFingerprint("/missing", { readFile: () => { throw new Error("missing"); } })).toBeNull();
  });
});
