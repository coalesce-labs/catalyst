// derivations-rail.test.ts — CTL-1103 Phase 4: pure logic tests for the
// derivations rail (subject→ticket extraction). No DOM. Run from ui/:
//   cd ui && bun test src/components/rulebook/derivations-rail.test.ts
import { describe, it, expect } from "bun:test";
import { subjectToTicket } from "./derivations-rail-model";

describe("subjectToTicket", () => {
  it("parses ticket from subject 'CTL-1/plan'", () => {
    expect(subjectToTicket("CTL-1/plan")).toBe("CTL-1");
  });

  it("parses ticket from subject 'CTL-999/implement'", () => {
    expect(subjectToTicket("CTL-999/implement")).toBe("CTL-999");
  });

  it("returns null for subjects without a slash", () => {
    expect(subjectToTicket("no-slash")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(subjectToTicket("")).toBeNull();
  });

  it("handles multi-segment subjects by returning the ticket part", () => {
    expect(subjectToTicket("CTL-42/verify/retry")).toBe("CTL-42");
  });
});
