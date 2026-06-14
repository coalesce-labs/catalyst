// ticket-type.test.mjs — CTL-1023: resolveTicketType work-type dimension.
// Run: cd plugins/dev/scripts/execution-core && bun test ticket-type.test.mjs
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveTicketType, UNKNOWN_TICKET_TYPE } from "./ticket-type.mjs";

let orchDir;

function writeTriage(ticket, obj) {
  const dir = join(orchDir, "workers", ticket);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "triage.json"), JSON.stringify(obj));
}

beforeEach(() => {
  orchDir = mkdtempSync(join(tmpdir(), "ctl1023-tickettype-"));
});
afterEach(() => {
  rmSync(orchDir, { recursive: true, force: true });
});

describe("resolveTicketType", () => {
  test("classified ticket — returns the triage.json classification", () => {
    writeTriage("CTL-1023", { classification: "feature", estimated_scope: "small" });
    expect(resolveTicketType(orchDir, "CTL-1023")).toBe("feature");
  });

  test("bug classification — returns 'bug'", () => {
    writeTriage("CTL-500", { classification: "bug" });
    expect(resolveTicketType(orchDir, "CTL-500")).toBe("bug");
  });

  test("no triage.json on disk — falls back to 'unknown'", () => {
    expect(resolveTicketType(orchDir, "CTL-404")).toBe(UNKNOWN_TICKET_TYPE);
    expect(resolveTicketType(orchDir, "CTL-404")).toBe("unknown");
  });

  test("triage.json present but classification null — falls back to 'unknown'", () => {
    writeTriage("CTL-1", { classification: null, type: null });
    expect(resolveTicketType(orchDir, "CTL-1")).toBe("unknown");
  });

  test("triage.json present but classification empty string — falls back to 'unknown'", () => {
    writeTriage("CTL-2", { classification: "   " });
    expect(resolveTicketType(orchDir, "CTL-2")).toBe("unknown");
  });

  test("malformed triage.json — fails open to 'unknown' (no throw)", () => {
    const dir = join(orchDir, "workers", "CTL-3");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "triage.json"), "{not json");
    expect(resolveTicketType(orchDir, "CTL-3")).toBe("unknown");
  });

  test("missing orchDir or ticket — 'unknown', no throw", () => {
    expect(resolveTicketType(undefined, "CTL-1023")).toBe("unknown");
    expect(resolveTicketType(orchDir, undefined)).toBe("unknown");
    expect(resolveTicketType(null, null)).toBe("unknown");
  });
});
