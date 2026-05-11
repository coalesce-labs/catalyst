import { describe, expect, test } from "bun:test";
import type { CanonicalEvent } from "../lib/canonical-event.ts";
import { buildDetailLines } from "../cli/components/DetailPane.tsx";

const baseEvent: CanonicalEvent = {
  ts: "2026-05-11T11:51:07.000Z",
  severityText: "INFO",
  severityNumber: 9,
  traceId: "abc123def456abc123def456abc123de",
  spanId: "abc123de456abc12",
  resource: {
    "service.name": "github-webhook",
    "service.namespace": "catalyst",
    "service.version": "8.4.0",
  },
  attributes: {
    "event.name": "github.workflow_run.in_progress",
    "vcs.repository.name": "coalesce-labs/catalyst",
  },
  body: { message: "" },
};

describe("DetailPane title line", () => {
  test("first line is a title with a 19-char fixed-width datetime", () => {
    const lines = buildDetailLines(baseEvent, 120);
    const first = lines[0];
    expect(first).toBeDefined();
    expect(first.k).toBe("title");
    if (first.k !== "title") return;
    expect(first.ts).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(first.ts.length).toBe(19);
    expect(first.name).toBe("github.workflow_run.in_progress");
    expect(first.sev).toBe("INFO");
  });

  test("title datetime contains no AM/PM at any width", () => {
    for (const cols of [80, 100, 120, 160, 200]) {
      const first = buildDetailLines(baseEvent, cols)[0];
      if (first?.k === "title") {
        expect(first.ts).not.toMatch(/AM|PM/i);
      }
    }
  });
});
