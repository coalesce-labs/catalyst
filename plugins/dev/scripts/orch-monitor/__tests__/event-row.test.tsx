import { describe, test, expect } from "bun:test";
import type { ReactElement, ReactNode } from "react";
import { EventRow } from "../cli/components/EventRow.tsx";
import { formatDetails } from "../cli/lib/format.ts";
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
  },
  attributes: {
    "event.name": "github.pr.merged",
    "vcs.repository.name": "coalesce-labs/catalyst",
    "vcs.pr.number": 501,
  },
  body: { message: longDetails, payload: {} },
};

// EventRow returns <Box>...{children}</Box>. The DETAILS cell is the one Box
// in the tree with flexGrow === 1 (see EventRow.tsx). Its child is the Text
// node whose wrap prop governs reflow behaviour.
function findDetailsTextNode(root: ReactNode): ReactElement | null {
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
    const props = node.props as { flexGrow?: number; children?: ReactNode };
    if (props.flexGrow === 1) {
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
    const element = EventRow({
      event: longDetailsEvent,
      selected: false,
      columns: 80,
      paused: true,
    });
    const detailsText = findDetailsTextNode(element);
    if (!detailsText) throw new Error("DETAILS Text node not found");
    expect((detailsText.props as { wrap?: string }).wrap).toBe("truncate");
  });

  test("DETAILS Text uses wrap=\"truncate\" at wide terminal width", () => {
    const element = EventRow({
      event: longDetailsEvent,
      selected: false,
      columns: 200,
      paused: true,
    });
    const detailsText = findDetailsTextNode(element);
    if (!detailsText) throw new Error("DETAILS Text node not found");
    expect((detailsText.props as { wrap?: string }).wrap).toBe("truncate");
  });

  test("DETAILS Text receives the full formatDetails output (renderer clips, formatter does not)", () => {
    const element = EventRow({
      event: longDetailsEvent,
      selected: false,
      columns: 80,
      paused: true,
    });
    const detailsText = findDetailsTextNode(element);
    if (!detailsText) throw new Error("DETAILS Text node not found");
    const children = (detailsText.props as { children?: unknown }).children;
    expect(children).toBe(formatDetails(longDetailsEvent));
    expect(children).toBe(longDetails);
  });
});
