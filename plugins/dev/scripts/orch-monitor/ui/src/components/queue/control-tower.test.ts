import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(import.meta.dir, "control-tower.tsx"), "utf8");

describe("CTL-1016 — ControlTower composes the four Dispatch sections", () => {
  it("renders SlotDeck, DispatchQueue, HoldingBuckets, and DeadStrip", () => {
    expect(src).toContain("<SlotDeck");
    expect(src).toContain("<DispatchQueue");
    expect(src).toContain("<HoldingBuckets");
    expect(src).toContain("<DeadStrip");
  });
  it("is router-free (takes data + onOpenTicket props, no useNavigate)", () => {
    expect(src).not.toContain("useNavigate");
    expect(src).toContain("onOpenTicket");
  });
});
