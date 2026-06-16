import { describe, test, expect } from "bun:test";
import { computeColumnWidths } from "../cli/lib/column-widths.ts";
import type { CanonicalEvent } from "../lib/canonical-event.ts";
import {
  formatStatus,
  formatOrch,
  formatWorker,
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
    "host.name": "test-host",
    "host.id": "0000000000000000",
  },
  attributes: { "event.name": "github.pr.merged" },
  body: {},
  ...overrides,
});

describe("computeColumnWidths", () => {
  test("at 80 cols hides STATUS, ORCH, WORKER", () => {
    const w = computeColumnWidths(80);
    expect(w.showStatus).toBe(false);
    expect(w.showOrch).toBe(false);
    expect(w.showWorker).toBe(false);
    expect(w.status).toBe(0);
    expect(w.orch).toBe(0);
    expect(w.worker).toBe(0);
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
    expect(w.worker).toBe(16);
  });

  test("at 200 cols enables STATUS + ORCH + WORKER", () => {
    const w = computeColumnWidths(200);
    expect(w.showStatus).toBe(true);
    expect(w.showOrch).toBe(true);
    expect(w.showWorker).toBe(true);
  });

  test("repo and ref widths clamp to sensible bounds", () => {
    const narrow = computeColumnWidths(80);
    const wide = computeColumnWidths(400);
    expect(narrow.repo).toBeGreaterThanOrEqual(10);
    expect(narrow.ref).toBeGreaterThanOrEqual(10);
    expect(wide.repo).toBeLessThanOrEqual(14);
    expect(wide.ref).toBeLessThanOrEqual(20);
  });

  // CTL-383: ORCH cap tightened from 24 → 18 so wide terminals leave more
  // room for DETAILS. Long orchestrator ids are still legible because the row
  // truncates with an ellipsis (see CTL-383 ORCH cell test in event-row.test.tsx)
  // and the substring filter (CTL-367) covers deep search.
  test("orch width clamps at 18 even on very wide terminals (CTL-383)", () => {
    const w = computeColumnWidths(400);
    expect(w.orch).toBeLessThanOrEqual(18);
  });

  test("orch width stays in the 16-18 range whenever ORCH is shown (CTL-383)", () => {
    for (const cols of [160, 180, 200, 240, 320, 400]) {
      const w = computeColumnWidths(cols);
      expect(w.showOrch).toBe(true);
      expect(w.orch).toBeGreaterThanOrEqual(16);
      expect(w.orch).toBeLessThanOrEqual(18);
    }
  });

  test("time column stays fixed at 10", () => {
    for (const cols of [80, 140, 200, 300]) {
      const w = computeColumnWidths(cols);
      expect(w.time).toBe(10);
    }
  });

  // CTL-364: SOURCE column dropped; EVENT column grew + became responsive so
  // the merged `${glyph} ${label}` content (longest: "CTL-330: attention" with
  // a 2-char glyph prefix = 20 chars) always fits without truncation.
  // CTL-391: EVENT now carries the raw event.name. Raw names are longer
  // than the legacy labels (`github.pr_review_comment.created` is 32 chars,
  // `filter.wake.<sessionId>` is 44+) so the responsive range grows to
  // 24–40 — EVENT is the most informative column on the row.
  test("event column has no minimum below 24 and caps at 40 on wide terminals", () => {
    expect(computeColumnWidths(80).event).toBeGreaterThanOrEqual(24);
    expect(computeColumnWidths(400).event).toBeLessThanOrEqual(40);
  });

  test("event column grows monotonically with terminal width", () => {
    const w80 = computeColumnWidths(80).event;
    const w160 = computeColumnWidths(160).event;
    const w240 = computeColumnWidths(240).event;
    const w400 = computeColumnWidths(400).event;
    expect(w160).toBeGreaterThanOrEqual(w80);
    expect(w240).toBeGreaterThanOrEqual(w160);
    expect(w400).toBeGreaterThanOrEqual(w240);
  });

  // CTL-391: 1-cell ICON column to the left of EVENT carries the source-family
  // Nerd Font glyph. Always rendered — even at the narrowest supported width
  // and even when no Nerd Font is detected — so columns stay aligned across
  // rows regardless of which events the terminal has rendered so far.
  test("icon column is a fixed 1 cell at every terminal width", () => {
    for (const cols of [80, 100, 160, 180, 200, 300, 400]) {
      expect(computeColumnWidths(cols).icon).toBe(1);
    }
  });
});

describe("status/orch/worker formatters", () => {
  test("formatStatus: CI success → ✓", () => {
    expect(
      formatStatus(makeEvent({
        attributes: {
          "event.name": "github.check_suite.completed",
          "cicd.pipeline.run.result": "success",
        },
      })),
    ).toBe("✓ ");
  });

  test("formatStatus: CI failure → ✗", () => {
    expect(
      formatStatus(makeEvent({
        attributes: {
          "event.name": "github.check_suite.completed",
          "cicd.pipeline.run.result": "failure",
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
          "cicd.pipeline.run.result": "in_progress",
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
          "cicd.pipeline.run.result": "in_progress",
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

});
