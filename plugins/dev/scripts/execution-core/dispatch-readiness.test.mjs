import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canOccupySlotNow, NOT_DISPATCHABLE_UNTRIAGED } from "./dispatch-readiness.mjs";

let orchDir;
beforeEach(() => {
  orchDir = mkdtempSync(join(tmpdir(), "cat36-readiness-"));
  mkdirSync(join(orchDir, "workers"), { recursive: true });
});
afterEach(() => rmSync(orchDir, { recursive: true, force: true }));

function seedTriage(ticket) {
  const dir = join(orchDir, "workers", ticket);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "triage.json"), JSON.stringify({ ticket }));
}

describe("canOccupySlotNow (CAT-36)", () => {
  test("a ticket with triage.json can occupy a slot", () => {
    seedTriage("CAT-1");
    expect(canOccupySlotNow(orchDir, "CAT-1")).toEqual({ ok: true, reason: null });
  });
  test("a ticket with no worker dir cannot occupy a slot", () => {
    expect(canOccupySlotNow(orchDir, "CAT-2")).toEqual({ ok: false, reason: NOT_DISPATCHABLE_UNTRIAGED });
  });
  test("a worker dir without triage.json cannot occupy a slot", () => {
    mkdirSync(join(orchDir, "workers", "CAT-3"));
    expect(canOccupySlotNow(orchDir, "CAT-3").ok).toBe(false);
  });
  test("honours the injected artifact probe", () => {
    expect(canOccupySlotNow(orchDir, "CAT-4", { hasTriageArtifact: () => true }).ok).toBe(true);
  });
  test("fails closed when the artifact probe throws", () => {
    expect(canOccupySlotNow(orchDir, "CAT-5", { hasTriageArtifact: () => { throw new Error("EACCES"); } })).toEqual({ ok: false, reason: NOT_DISPATCHABLE_UNTRIAGED });
  });
});
