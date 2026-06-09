// cluster-claim-sync.test.mjs — the synchronous spawnSync bridge over the
// cluster-claim CLI (CTL-850). Every test injects a fake `spawn` so nothing
// actually forks a process; the focus is argv construction + stdout parsing +
// the FAIL-CLOSED contract (won:false on any failure).
import { describe, it, expect } from "bun:test";

import { claimDispatchSync } from "./cluster-claim-sync.mjs";

describe("claimDispatchSync — argv + parsing", () => {
  it("builds the right argv: node <cli> claim <ticket> <host> <phase>", () => {
    let captured;
    const spawn = (bin, args) => {
      captured = { bin, args };
      return { status: 0, stdout: JSON.stringify({ won: true, generation: 1 }) + "\n" };
    };
    claimDispatchSync(
      { ticket: "CTL-7", hostName: "mac-studio", phase: "triage" },
      { spawn, nodeBin: "/usr/bin/node", cli: "/x/cluster-claim.mjs" },
    );
    expect(captured.bin).toBe("/usr/bin/node");
    expect(captured.args).toEqual([
      "/x/cluster-claim.mjs",
      "claim",
      "CTL-7",
      "mac-studio",
      "triage",
    ]);
  });

  it("parses {won, generation} from the CLI stdout on exit 0", () => {
    const spawn = () => ({ status: 0, stdout: JSON.stringify({ won: true, generation: 3 }) + "\n" });
    expect(claimDispatchSync({ ticket: "CTL-1", hostName: "mini", phase: "research" }, { spawn })).toEqual({
      won: true,
      generation: 3,
    });
  });

  it("won:false from stdout is preserved (a lost soft-CAS, not an error)", () => {
    const spawn = () => ({ status: 0, stdout: JSON.stringify({ won: false, generation: 2 }) + "\n" });
    expect(claimDispatchSync({ ticket: "CTL-1", hostName: "mini", phase: "research" }, { spawn })).toEqual({
      won: false,
      generation: 2,
    });
  });
});

describe("claimDispatchSync — FAIL-CLOSED on every failure mode", () => {
  it("non-zero exit → won:false", () => {
    const spawn = () => ({ status: 1, stdout: "" });
    expect(claimDispatchSync({ ticket: "CTL-1", hostName: "mini", phase: "research" }, { spawn })).toEqual({
      won: false,
      generation: null,
    });
  });

  it("unparseable stdout → won:false", () => {
    const spawn = () => ({ status: 0, stdout: "not json at all" });
    expect(claimDispatchSync({ ticket: "CTL-1", hostName: "mini", phase: "research" }, { spawn })).toEqual({
      won: false,
      generation: null,
    });
  });

  it("timeout / spawn error (status null) → won:false", () => {
    const spawn = () => ({ status: null, error: new Error("ETIMEDOUT"), stdout: null });
    expect(claimDispatchSync({ ticket: "CTL-1", hostName: "mini", phase: "research" }, { spawn })).toEqual({
      won: false,
      generation: null,
    });
  });

  it("spawn throws → won:false (never propagates)", () => {
    const spawn = () => {
      throw new Error("EACCES");
    };
    expect(claimDispatchSync({ ticket: "CTL-1", hostName: "mini", phase: "research" }, { spawn })).toEqual({
      won: false,
      generation: null,
    });
  });

  it("missing/garbage generation in stdout → generation null but won honoured", () => {
    const spawn = () => ({ status: 0, stdout: JSON.stringify({ won: true }) + "\n" });
    expect(claimDispatchSync({ ticket: "CTL-1", hostName: "mini", phase: "research" }, { spawn })).toEqual({
      won: true,
      generation: null,
    });
  });
});

// ─── CTL-863: fenceCheckSync ──────────────────────────────────────────────────

import { fenceCheckSync } from "./cluster-claim-sync.mjs";

describe("fenceCheckSync — argv, parsing, fail-closed (CTL-863)", () => {
  it("builds the right argv: node <cli> fence-check <ticket> <gen>", () => {
    let captured;
    const spawn = (bin, args) => {
      captured = { bin, args };
      return { status: 0, stdout: JSON.stringify({ current: true }) + "\n" };
    };
    fenceCheckSync(
      { ticket: "CTL-1", generation: 3 },
      { spawn, nodeBin: "/usr/bin/node", cli: "/x/cluster-claim.mjs" },
    );
    expect(captured.bin).toBe("/usr/bin/node");
    expect(captured.args).toEqual(["/x/cluster-claim.mjs", "fence-check", "CTL-1", "3"]);
  });

  it("exit 0 ⇒ current true", () => {
    const spawn = () => ({ status: 0, stdout: JSON.stringify({ current: true }) + "\n" });
    expect(fenceCheckSync({ ticket: "CTL-1", generation: 3 }, { spawn })).toEqual({ current: true });
  });

  it("exit 10 (stale) ⇒ current false", () => {
    const spawn = () => ({ status: 10, stdout: JSON.stringify({ current: false }) + "\n" });
    expect(fenceCheckSync({ ticket: "CTL-1", generation: 2 }, { spawn })).toEqual({ current: false });
  });

  it("spawn throws (ENOENT) ⇒ current false (fail-closed)", () => {
    const spawn = () => { throw new Error("ENOENT"); };
    expect(fenceCheckSync({ ticket: "CTL-1", generation: 2 }, { spawn })).toEqual({ current: false });
  });

  it("garbage stdout ⇒ current false", () => {
    const spawn = () => ({ status: 0, stdout: "not json" });
    expect(fenceCheckSync({ ticket: "CTL-1", generation: 2 }, { spawn })).toEqual({ current: false });
  });

  it("stdout current:false on non-stale exit ⇒ current false (trusts payload over exit code)", () => {
    const spawn = () => ({ status: 0, stdout: JSON.stringify({ current: false }) + "\n" });
    expect(fenceCheckSync({ ticket: "CTL-1", generation: 5 }, { spawn })).toEqual({ current: false });
  });

  it("null/missing res ⇒ current false", () => {
    const spawn = () => null;
    expect(fenceCheckSync({ ticket: "CTL-1", generation: 1 }, { spawn })).toEqual({ current: false });
  });
});
