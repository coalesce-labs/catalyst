import { describe, test, expect } from "bun:test";
import { computeColumnWidths } from "../cli/lib/column-widths.ts";
import type { CanonicalEvent } from "../lib/canonical-event.ts";
import {
  formatStatus,
  formatOrch,
  formatWorker,
  formatEventIdShort,
} from "../cli/lib/format.ts";

const makeEvent = (overrides: Partial<CanonicalEvent> = {}): CanonicalEvent => ({
  ts: "2026-05-12T21:08:40.000Z",
  id: "11111111-2222-4333-8444-555555555555",
  severityText: "INFO",
  severityNumber: 9,
  traceId: null,
  spanId: null,
  resource: {
    "service.name": "test",
    "service.namespace": "catalyst",
    "service.version": "0.0.0",
  },
  attributes: { "event.name": "github.pr.merged" },
  body: {},
  ...overrides,
});

describe("computeColumnWidths", () => {
  test("at 80 cols hides STATUS, ORCH, WORKER, EVENT-ID", () => {
    const w = computeColumnWidths(80);
    expect(w.showStatus).toBe(false);
    expect(w.showOrch).toBe(false);
    expect(w.showWorker).toBe(false);
    expect(w.showEventId).toBe(false);
    expect(w.status).toBe(0);
    expect(w.orch).toBe(0);
    expect(w.worker).toBe(0);
    expect(w.eventId).toBe(0);
  });

  test("at 100 cols enables STATUS only", () => {
    const w = computeColumnWidths(100);
    expect(w.showStatus).toBe(true);
    expect(w.showOrch).toBe(false);
    // CTL-351: ⏳ (U+23F3) renders 2 cells wide in most terminals; +1 trailing
    // gutter = 3-wide status column so the glyph never pushes following
    // columns right on in-progress rows.
    expect(w.status).toBe(3);
  });

  test("at 160 cols enables STATUS + ORCH", () => {
    const w = computeColumnWidths(160);
    expect(w.showStatus).toBe(true);
    expect(w.showOrch).toBe(true);
    expect(w.showWorker).toBe(false);
    expect(w.orch).toBeGreaterThanOrEqual(16);
  });

  test("at 180 cols enables STATUS + ORCH + WORKER", () => {
    const w = computeColumnWidths(180);
    expect(w.showWorker).toBe(true);
    expect(w.showEventId).toBe(false);
    expect(w.worker).toBe(16);
  });

  test("at 200 cols enables all optional columns", () => {
    const w = computeColumnWidths(200);
    expect(w.showStatus).toBe(true);
    expect(w.showOrch).toBe(true);
    expect(w.showWorker).toBe(true);
    expect(w.showEventId).toBe(true);
    expect(w.eventId).toBe(10);
  });

  test("repo and ref widths clamp to sensible bounds", () => {
    const narrow = computeColumnWidths(80);
    const wide = computeColumnWidths(400);
    expect(narrow.repo).toBeGreaterThanOrEqual(10);
    expect(narrow.ref).toBeGreaterThanOrEqual(10);
    expect(wide.repo).toBeLessThanOrEqual(14);
    expect(wide.ref).toBeLessThanOrEqual(20);
  });

  test("orch width clamps at 24 even on very wide terminals", () => {
    const w = computeColumnWidths(400);
    expect(w.orch).toBeLessThanOrEqual(24);
  });

  test("time and event columns stay fixed at 10 and 16", () => {
    for (const cols of [80, 140, 200, 300]) {
      const w = computeColumnWidths(cols);
      expect(w.time).toBe(10);
      expect(w.event).toBe(16);
    }
  });
});

describe("status/orch/worker/event-id formatters", () => {
  test("formatStatus: CI success → ✓", () => {
    expect(
      formatStatus(makeEvent({
        attributes: {
          "event.name": "github.check_suite.completed",
          "cicd.pipeline.run.conclusion": "success",
        },
      })),
    ).toBe("✓ ");
  });

  test("formatStatus: CI failure → ✗", () => {
    expect(
      formatStatus(makeEvent({
        attributes: {
          "event.name": "github.check_suite.completed",
          "cicd.pipeline.run.conclusion": "failure",
        },
      })),
    ).toBe("✗ ");
  });

  test("formatStatus: ERROR severity → ✗", () => {
    expect(formatStatus(makeEvent({ severityText: "ERROR" }))).toBe("✗ ");
  });

  test("formatStatus: WARN severity → !", () => {
    expect(formatStatus(makeEvent({ severityText: "WARN" }))).toBe("! ");
  });

  test("formatStatus: default INFO → ·", () => {
    expect(formatStatus(makeEvent())).toBe("· ");
  });

  // CTL-353: in-progress uses Nerd Font when available, else "…". Both
  // branches return a 2-char string (1-cell glyph + trailing space).
  test("formatStatus: in_progress conclusion → '… ' when CATALYST_NERD_FONT=0", async () => {
    const { _resetNerdFontCacheForTesting } = await import("../cli/lib/nerd-font.ts");
    const prev = process.env.CATALYST_NERD_FONT;
    process.env.CATALYST_NERD_FONT = "0";
    _resetNerdFontCacheForTesting();
    try {
      const result = formatStatus(makeEvent({
        attributes: {
          "event.name": "github.workflow_run.in_progress",
          "cicd.pipeline.run.conclusion": "in_progress",
        },
      }));
      expect(result).toBe("… ");
    } finally {
      if (prev === undefined) delete process.env.CATALYST_NERD_FONT;
      else process.env.CATALYST_NERD_FONT = prev;
      _resetNerdFontCacheForTesting();
    }
  });

  test("formatStatus: in_progress conclusion → PUA hourglass when CATALYST_NERD_FONT=1", async () => {
    const { _resetNerdFontCacheForTesting } = await import("../cli/lib/nerd-font.ts");
    const prev = process.env.CATALYST_NERD_FONT;
    process.env.CATALYST_NERD_FONT = "1";
    _resetNerdFontCacheForTesting();
    try {
      const result = formatStatus(makeEvent({
        attributes: {
          "event.name": "github.workflow_run.in_progress",
          "cicd.pipeline.run.conclusion": "in_progress",
        },
      }));
      expect(result.codePointAt(0)).toBe(0xf252);
      expect(result.charAt(1)).toBe(" ");
    } finally {
      if (prev === undefined) delete process.env.CATALYST_NERD_FONT;
      else process.env.CATALYST_NERD_FONT = prev;
      _resetNerdFontCacheForTesting();
    }
  });

  test("formatOrch returns the orchestrator id when present, else empty", () => {
    expect(
      formatOrch(makeEvent({
        attributes: {
          "event.name": "x",
          "catalyst.orchestrator.id": "orch-adv-925-2026-05-12",
        },
      })),
    ).toBe("orch-adv-925-2026-05-12");
    expect(formatOrch(makeEvent())).toBe("");
  });

  test("formatWorker returns the worker ticket when present", () => {
    expect(
      formatWorker(makeEvent({
        attributes: { "event.name": "x", "catalyst.worker.ticket": "ADV-87" },
      })),
    ).toBe("ADV-87");
    expect(formatWorker(makeEvent())).toBe("");
  });

  test("formatEventIdShort returns first 8 chars of UUID", () => {
    expect(formatEventIdShort(makeEvent())).toBe("11111111");
  });

  test("formatEventIdShort returns empty string when id missing", () => {
    const evt = makeEvent();
    evt.id = "";
    expect(formatEventIdShort(evt)).toBe("");
  });
});
