// CTL-1239: a ticket terminal in Linear (Done/Canceled) must never surface as
// needs-human / waiting-on-you, regardless of a stale failed/stalled phase signal,
// and its dead bg-job corpse must drop from the dead-worker set. Covered via the
// exported pure functions assembleBoard composes from (assembleBoard itself is not
// unit-testable — WORKERS_DIR is a homedir const).
import { describe, it, expect } from "bun:test";

const { deriveAttention, isTerminalDeadCorpse } = await import("./lib/board-data.mjs");

describe("deriveAttention — linearTerminal short-circuit (CTL-1239)", () => {
  it("linearTerminal:true overrides phaseFailed:true → attention:null", () => {
    const r = deriveAttention({ phaseFailed: true, escalationType: "forensic", linearTerminal: true });
    expect(r.attention).toBeNull();
    expect(r.attentionSince).toBeNull();
    expect(r.escalationType).toBeNull();
  });

  it("linearTerminal:true overrides needsHumanMarker:true → attention:null", () => {
    expect(deriveAttention({ needsHumanMarker: true, linearTerminal: true }).attention).toBeNull();
  });

  it("linearTerminal:true overrides a needs-human label → attention:null", () => {
    expect(deriveAttention({ labels: ["needs-human"], linearTerminal: true }).attention).toBeNull();
  });

  it("linearTerminal:true overrides waitingOnUser:true → attention:null", () => {
    expect(deriveAttention({ waitingOnUser: true, waitingSince: "2026-06-17T00:00:00Z", linearTerminal: true }).attention).toBeNull();
  });

  it("linearTerminal:false leaves phaseFailed:true → needs-human (unchanged)", () => {
    expect(deriveAttention({ phaseFailed: true, linearTerminal: false }).attention).toBe("needs-human");
  });

  it("default (no linearTerminal) preserves prior behavior — back-compat", () => {
    expect(deriveAttention({ phaseFailed: true }).attention).toBe("needs-human");
    expect(deriveAttention({ waitingOnUser: true }).attention).toBe("waiting-on-you");
  });
});

describe("isTerminalDeadCorpse (CTL-1239)", () => {
  it("dead worker on a Done ticket → true", () => {
    expect(isTerminalDeadCorpse({ activeState: "dead" }, "Done")).toBe(true);
  });
  it("dead worker on a Canceled ticket → true", () => {
    expect(isTerminalDeadCorpse({ activeState: "dead" }, "Canceled")).toBe(true);
  });
  it("dead worker on a non-terminal ticket → false (still a real corpse)", () => {
    expect(isTerminalDeadCorpse({ activeState: "dead" }, "Implement")).toBe(false);
  });
  it("live worker on a Done ticket → false (genuinely active)", () => {
    expect(isTerminalDeadCorpse({ activeState: "active" }, "Done")).toBe(false);
  });
  it("null linearState → false", () => {
    expect(isTerminalDeadCorpse({ activeState: "dead" }, null)).toBe(false);
  });
});
