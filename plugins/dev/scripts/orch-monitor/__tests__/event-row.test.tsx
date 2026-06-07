import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import type { ReactElement, ReactNode } from "react";
// CTL-473: import the unwrapped impl. The `EventRow` named export is a
// MemoExoticComponent (not callable as a function); these tests walk the
// React element tree directly, so they need the raw render function.
import { EventRowImpl as EventRow } from "../cli/components/EventRow.tsx";
import { formatDetails, formatEvent, formatIcon } from "../cli/lib/format.ts";
import { computeColumnWidths } from "../cli/lib/column-widths.ts";
import { _resetNerdFontCacheForTesting } from "../cli/lib/nerd-font.ts";
import type { CanonicalEvent } from "../lib/canonical-event.ts";

// CTL-361: long DETAILS strings must never reflow onto the next terminal line.
// Ink reflows by default (wrap="wrap"); EventRow's DETAILS cell must opt into
// wrap="truncate" so excess content hard-clips at the cell's right edge.
//
// The formatter (formatDetails) intentionally returns the full string — clipping
// is the renderer's job. These tests verify the rendering contract directly by
// walking the React element tree EventRow returns.

const longDetails = "x".repeat(800);

const longDetailsEvent: CanonicalEvent = {
  ts: "2026-05-13T13:40:00.000Z",
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
  attributes: {
    "event.name": "orchestrator.worker.done",
    "vcs.repository.name": "coalesce-labs/catalyst",
    "vcs.pr.number": 501,
  },
  body: { message: longDetails, payload: {} },
};

// EventRow returns <Box>...{children}</Box>. The DETAILS cell is the one Box
// in the tree with width === w.details (CTL-395: explicit width replaced the
// former flexGrow={1}). Its child is the Text node whose wrap prop governs
// reflow behaviour.
function findDetailsTextNode(root: ReactNode, columns: number): ReactElement | null {
  const w = computeColumnWidths(columns);
  function isReactElement(node: unknown): node is ReactElement {
    return (
      typeof node === "object" &&
      node !== null &&
      "props" in node &&
      "type" in node
    );
  }
  function walk(node: ReactNode): ReactElement | null {
    if (!isReactElement(node)) return null;
    const props = node.props as { width?: number; children?: ReactNode };
    if (props.width === w.details) {
      // The DETAILS Box. Its only child is the DETAILS Text node.
      const child = props.children;
      return isReactElement(child) ? child : null;
    }
    const children = props.children;
    if (Array.isArray(children)) {
      for (const c of children) {
        const found = walk(c as ReactNode);
        if (found) return found;
      }
    } else if (children !== undefined && children !== null) {
      return walk(children);
    }
    return null;
  }
  return walk(root);
}

describe("EventRow DETAILS cell (CTL-361)", () => {
  test("DETAILS Text uses wrap=\"truncate\" at narrow terminal width", () => {
    const cols = 80;
    const element = EventRow({
      event: longDetailsEvent,
      selected: false,
      columns: cols,
      paused: true,
    });
    const detailsText = findDetailsTextNode(element, cols);
    if (!detailsText) throw new Error("DETAILS Text node not found");
    expect((detailsText.props as { wrap?: string }).wrap).toBe("truncate");
  });

  test("DETAILS Text uses wrap=\"truncate\" at wide terminal width", () => {
    const cols = 200;
    const element = EventRow({
      event: longDetailsEvent,
      selected: false,
      columns: cols,
      paused: true,
    });
    const detailsText = findDetailsTextNode(element, cols);
    if (!detailsText) throw new Error("DETAILS Text node not found");
    expect((detailsText.props as { wrap?: string }).wrap).toBe("truncate");
  });

  test("DETAILS Text receives the full formatDetails output (renderer clips, formatter does not)", () => {
    const cols = 80;
    const element = EventRow({
      event: longDetailsEvent,
      selected: false,
      columns: cols,
      paused: true,
    });
    const detailsText = findDetailsTextNode(element, cols);
    if (!detailsText) throw new Error("DETAILS Text node not found");
    const children = (detailsText.props as { children?: unknown }).children;
    expect(children).toBe(formatDetails(longDetailsEvent));
    expect(children).toBe(longDetails);
  });
});

// CTL-383: long orchestrator IDs (e.g. multi-ticket o-adv-944-946-947-… runs)
// must not reflow the ORCH cell onto a second terminal line. The fix is the
// same pattern used for EVENT (CTL-364) and DETAILS (CTL-361): set
// wrap="truncate" on the ORCH <Text>. Ink emits an ellipsis at the cell's
// right edge instead of wrapping. formatOrch is intentionally left
// untruncated — clipping is the renderer's job.

const longOrchId = "o-adv-944-946-947-949-950-939-937-938-903-ADV-937";

const longOrchEvent: CanonicalEvent = {
  ts: "2026-05-14T13:40:00.000Z",
  id: "22222222-3333-4444-8555-666666666666",
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
  attributes: {
    "event.name": "orchestrator.worker.done",
    "catalyst.orchestrator.id": longOrchId,
    "catalyst.worker.ticket": "ADV-937",
  },
  body: { payload: {} },
};

// The ORCH cell is the Box whose `width` matches `computeColumnWidths(cols).orch`
// AND whose only child is a Text node carrying the orchestrator id. Identifying
// by both width and content avoids false positives from other columns that
// happen to share the same width at certain terminal sizes.
function findOrchTextNode(root: ReactNode, expectedWidth: number, expectedContent: string): ReactElement | null {
  function isReactElement(node: unknown): node is ReactElement {
    return (
      typeof node === "object" &&
      node !== null &&
      "props" in node &&
      "type" in node
    );
  }
  function walk(node: ReactNode): ReactElement | null {
    if (!isReactElement(node)) return null;
    const props = node.props as { width?: number; children?: ReactNode };
    if (props.width === expectedWidth) {
      const child = props.children;
      if (isReactElement(child)) {
        const childProps = child.props as { children?: unknown };
        if (childProps.children === expectedContent) return child;
      }
    }
    const children = props.children;
    if (Array.isArray(children)) {
      for (const c of children) {
        const found = walk(c as ReactNode);
        if (found) return found;
      }
    } else if (children !== undefined && children !== null) {
      return walk(children);
    }
    return null;
  }
  return walk(root);
}

describe("EventRow ORCH cell (CTL-383)", () => {
  test("ORCH Text uses wrap=\"truncate\" so long orchestrator ids do not reflow", () => {
    const cols = 200;
    const w = computeColumnWidths(cols);
    expect(w.showOrch).toBe(true);

    const element = EventRow({
      event: longOrchEvent,
      selected: false,
      columns: cols,
      paused: true,
    });
    const orchText = findOrchTextNode(element, w.orch, longOrchId);
    if (!orchText) throw new Error("ORCH Text node not found");
    expect((orchText.props as { wrap?: string }).wrap).toBe("truncate");
  });

  test("ORCH Text receives the full orch id (renderer clips, formatter does not)", () => {
    const cols = 200;
    const w = computeColumnWidths(cols);

    const element = EventRow({
      event: longOrchEvent,
      selected: false,
      columns: cols,
      paused: true,
    });
    const orchText = findOrchTextNode(element, w.orch, longOrchId);
    if (!orchText) throw new Error("ORCH Text node not found");
    const children = (orchText.props as { children?: unknown }).children;
    expect(children).toBe(longOrchId);
  });
});

// CTL-391: ICON column is the first Box in the row with width === w.icon (1).
// Walk the tree and capture every Box's width + child Text content so tests
// can assert structural ordering and content independently.
interface CellSnapshot {
  width: number;
  text: string;
  wrap?: string;
}

function collectFixedWidthCells(root: ReactNode): CellSnapshot[] {
  // Collect all fixed-width cells (explicit width). CTL-395: DETAILS now also
  // uses an explicit width instead of flexGrow={1}, so it appears in this list
  // as the last cell. CTL-391 tests find cells by specific widths, so DETAILS
  // being present at the end does not affect those assertions.
  const cells: CellSnapshot[] = [];
  function isReactElement(node: unknown): node is ReactElement {
    return typeof node === "object" && node !== null && "props" in node && "type" in node;
  }
  function walk(node: ReactNode): void {
    if (!isReactElement(node)) return;
    const props = node.props as {
      width?: number;
      children?: ReactNode;
    };
    if (typeof props.width === "number") {
      const child = props.children;
      if (isReactElement(child)) {
        const childProps = child.props as { children?: unknown; wrap?: string };
        const text = typeof childProps.children === "string" ? childProps.children : "";
        cells.push({ width: props.width, text, wrap: childProps.wrap });
      }
    }
    const children = props.children;
    if (Array.isArray(children)) {
      for (const c of children) walk(c as ReactNode);
    } else if (children !== undefined && children !== null) {
      walk(children);
    }
  }
  walk(root);
  return cells;
}

describe("EventRow ICON + EVENT columns (CTL-391)", () => {
  const prevEnv = process.env.CATALYST_NERD_FONT;
  beforeAll(() => {
    process.env.CATALYST_NERD_FONT = "0";
    _resetNerdFontCacheForTesting();
  });
  afterAll(() => {
    if (prevEnv === undefined) delete process.env.CATALYST_NERD_FONT;
    else process.env.CATALYST_NERD_FONT = prevEnv;
    _resetNerdFontCacheForTesting();
  });

  const ghEvent: CanonicalEvent = {
    ts: "2026-05-14T13:40:00.000Z",
    id: "22222222-3333-4444-8555-666666666666",
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
    attributes: {
      "event.name": "github.pr.merged",
      "vcs.repository.name": "coalesce-labs/catalyst",
      "vcs.pr.number": 501,
    },
    body: { message: "PR merged", payload: {} },
  };

  // Helper: assert a cell was found, narrowing the type for the test body.
  // The fixed-width cell collector returns `CellSnapshot | undefined` (from
  // Array#find), so the test asserts presence first and then reads fields.
  function mustExist(cell: CellSnapshot | undefined, label: string): CellSnapshot {
    if (cell === undefined) throw new Error(`expected to find cell: ${label}`);
    return cell;
  }

  test("renders ICON cell (width 1) immediately before EVENT cell", () => {
    const element = EventRow({ event: ghEvent, selected: false, columns: 200, paused: true });
    const cells = collectFixedWidthCells(element);
    const widths = computeColumnWidths(200);
    const iconIdx = cells.findIndex((c) => c.width === widths.icon && c.width === 1);
    expect(iconIdx).toBeGreaterThanOrEqual(0);
    // The cell immediately after the ICON column must be EVENT (width matches
    // the computed EVENT width and its Text uses wrap="truncate").
    const eventCell = mustExist(cells[iconIdx + 1], "EVENT cell after ICON");
    expect(eventCell.width).toBe(widths.event);
    expect(eventCell.wrap).toBe("truncate");
  });

  test("ICON cell renders the formatIcon output (blank when no Nerd Font)", () => {
    const element = EventRow({ event: ghEvent, selected: false, columns: 200, paused: true });
    const cells = collectFixedWidthCells(element);
    const iconCell = mustExist(cells.find((c) => c.width === 1), "ICON cell");
    // CATALYST_NERD_FONT=0 → formatIcon returns "" so the cell text is empty.
    expect(iconCell.text).toBe(formatIcon(ghEvent));
    expect(iconCell.text).toBe("");
  });

  test("EVENT cell renders the raw event.name (no friendly label substitution)", () => {
    const element = EventRow({ event: ghEvent, selected: false, columns: 200, paused: true });
    const cells = collectFixedWidthCells(element);
    const widths = computeColumnWidths(200);
    const eventCell = mustExist(
      cells.find((c) => c.width === widths.event && c.wrap === "truncate"),
      "EVENT cell",
    );
    expect(eventCell.text).toBe(formatEvent(ghEvent));
    expect(eventCell.text).toBe("github.pr.merged");
  });

  test("EVENT cell carries the full filter.wake.<sessionId> name verbatim", () => {
    const wakeEvent: CanonicalEvent = {
      ...ghEvent,
      id: "33333333-4444-4555-8666-777777777777",
      attributes: { "event.name": "filter.wake.sess_20260511T203845_16d33281" },
      body: { payload: { reason: "ci passed" } },
    };
    const element = EventRow({ event: wakeEvent, selected: false, columns: 200, paused: true });
    const cells = collectFixedWidthCells(element);
    const widths = computeColumnWidths(200);
    const eventCell = mustExist(
      cells.find((c) => c.width === widths.event && c.wrap === "truncate"),
      "EVENT cell (filter.wake)",
    );
    expect(eventCell.text).toBe("filter.wake.sess_20260511T203845_16d33281");
  });
});

describe("EventRow ICON column (CTL-391, Nerd Font enabled)", () => {
  const prevEnv = process.env.CATALYST_NERD_FONT;
  beforeAll(() => {
    process.env.CATALYST_NERD_FONT = "1";
    _resetNerdFontCacheForTesting();
  });
  afterAll(() => {
    if (prevEnv === undefined) delete process.env.CATALYST_NERD_FONT;
    else process.env.CATALYST_NERD_FONT = prevEnv;
    _resetNerdFontCacheForTesting();
  });

  test("ICON cell renders the source-family glyph alone (no trailing space)", () => {
    const ghEvent: CanonicalEvent = {
      ts: "2026-05-14T13:40:00.000Z",
      id: "44444444-5555-4666-8777-888888888888",
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
      attributes: {
        "event.name": "github.pr.merged",
        "vcs.repository.name": "coalesce-labs/catalyst",
      },
      body: { payload: {} },
    };
    const element = EventRow({ event: ghEvent, selected: false, columns: 200, paused: true });
    const cells = collectFixedWidthCells(element);
    const iconCell = cells.find((c) => c.width === 1);
    if (iconCell === undefined) throw new Error("expected to find ICON cell");
    expect(iconCell.text.length).toBe(1);
    expect(iconCell.text.codePointAt(0)).toBe(0xf09b); // nf-fa-github
  });
});
