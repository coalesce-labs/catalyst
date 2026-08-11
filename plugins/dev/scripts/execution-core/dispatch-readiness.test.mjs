import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canOccupySlotNow,
  NOT_DISPATCHABLE_LIVENESS_ANCHOR,
  NOT_DISPATCHABLE_TRIAGE_PROBE_ERROR,
  NOT_DISPATCHABLE_UNTRIAGED,
} from "./dispatch-readiness.mjs";

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
  test("holds the liveness anchor before probing its triage artifact", () => {
    seedTriage("CAT-1");
    expect(canOccupySlotNow(orchDir, "CAT-1", { anchorIssue: "CAT-1" })).toEqual({
      ok: false,
      reason: NOT_DISPATCHABLE_LIVENESS_ANCHOR,
    });
  });
  test("admits a triaged non-anchor", () => {
    seedTriage("CAT-2");
    expect(canOccupySlotNow(orchDir, "CAT-2", { anchorIssue: "CAT-1" })).toEqual({ ok: true, reason: null });
  });
  test("an unresolved anchor config preserves existing behavior", () => {
    expect(canOccupySlotNow(orchDir, "CAT-1", { anchorIssue: null })).toEqual({
      ok: false,
      reason: NOT_DISPATCHABLE_UNTRIAGED,
    });
  });
  test("a ticket with triage.json can occupy a slot", () => {
    seedTriage("CAT-1");
    expect(canOccupySlotNow(orchDir, "CAT-1", { anchorIssue: null })).toEqual({ ok: true, reason: null });
  });
  test("a ticket with no worker dir cannot occupy a slot", () => {
    expect(canOccupySlotNow(orchDir, "CAT-2", { anchorIssue: null })).toEqual({
      ok: false,
      reason: NOT_DISPATCHABLE_UNTRIAGED,
    });
  });
  test("a worker dir without triage.json cannot occupy a slot", () => {
    mkdirSync(join(orchDir, "workers", "CAT-3"));
    expect(canOccupySlotNow(orchDir, "CAT-3", { anchorIssue: null }).ok).toBe(false);
  });
  test("honours the injected artifact probe", () => {
    expect(canOccupySlotNow(orchDir, "CAT-4", { hasTriageArtifact: () => true, anchorIssue: null }).ok).toBe(true);
  });
  test("fails closed when the artifact probe throws", () => {
    const result = canOccupySlotNow(orchDir, "CAT-5", {
      anchorIssue: null,
      hasTriageArtifact: () => {
        throw new Error("EACCES");
      },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe(NOT_DISPATCHABLE_TRIAGE_PROBE_ERROR);
    expect(result.error).toBeInstanceOf(Error);
  });
});
