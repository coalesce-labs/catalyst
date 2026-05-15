// interest-list-footer.test.ts — verifies footerSummary in InterestList.tsx
// renders " ago" only when the underlying timestamp is non-null (CTL-432).

import { describe, test, expect } from "bun:test";
import { footerSummary } from "./InterestList.tsx";
import type { BrokerState } from "../lib/broker-key-health.ts";

const NOW = Date.parse("2026-05-15T15:00:00Z");

describe("footerSummary", () => {
  test("null brokerState — no ' ago' on em-dash placeholders", () => {
    const out = footerSummary([], null, NOW);
    expect(out).toContain("last wake —  ·");
    expect(out).toContain("last register —  ·");
    expect(out).not.toContain("— ago");
  });

  test("both timestamps present — ' ago' suffix appears", () => {
    const state: BrokerState = {
      lastWakeAt: "2026-05-15T14:55:00Z",
      lastRegisterAt: "2026-05-15T14:50:00Z",
    };
    const out = footerSummary([], state, NOW);
    expect(out).toMatch(/last wake \S+ ago {2}·/);
    expect(out).toMatch(/last register \S+ ago {2}·/);
  });

  test("mixed — wake set, register null — only wake gets ' ago'", () => {
    const state: BrokerState = {
      lastWakeAt: "2026-05-15T14:55:00Z",
      lastRegisterAt: null,
    };
    const out = footerSummary([], state, NOW);
    expect(out).toMatch(/last wake \S+ ago {2}·/);
    expect(out).toContain("last register —  ·");
    expect(out).not.toContain("— ago");
  });

  test("daemon up segment never carries ' ago' even when startedAt is set", () => {
    const state: BrokerState = { startedAt: "2026-05-15T13:00:00Z" };
    const out = footerSummary([], state, NOW);
    expect(out).toMatch(/daemon up \S+$/);
    expect(out).not.toMatch(/daemon up \S+ ago/);
  });
});
