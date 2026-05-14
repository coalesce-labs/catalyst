// CTL-388: pure decision logic for the o/t "scope" keys in the HUD.
//
// CTL-351 made the cursor invisible during live (auto-follow) tailing so the
// streaming events don't carry distracting inverse-video highlights. CTL-388
// closes the resulting UX gap: pressing o or t in live mode would silently
// filter to whatever event the (invisible) cursor happened to be parked on at
// the bottom of the list. The fix forces the user to pause first — making the
// cursor visible — and only applies the scope on a second press.
//
// hud.tsx's useInput handler is a thin dispatcher; the per-key branching and
// status-message wording live here so they can be unit-tested.

import type { CanonicalEvent } from "../../lib/canonical-event.ts";

export type PivotKey = "o" | "t";

export type PivotAction =
  | { kind: "pivot"; pivot: { type: "orch" | "trace"; id: string }; status: string }
  | { kind: "pause"; status: string }
  | { kind: "noop"; status: string };

export interface DecidePivotInput {
  key: PivotKey;
  autoFollow: boolean;
  selectedEvent: CanonicalEvent | null;
}

const PAUSE_STATUS =
  "paused — use ↑/↓ to select an event, then o:scope-orch t:scope-trace, G:resume live";

export function decidePivotAction(input: DecidePivotInput): PivotAction {
  const { key, autoFollow, selectedEvent } = input;

  if (autoFollow) {
    return { kind: "pause", status: PAUSE_STATUS };
  }

  if (!selectedEvent) {
    return { kind: "noop", status: "no event selected" };
  }

  if (key === "o") {
    const orchId = selectedEvent.attributes["catalyst.orchestrator.id"];
    if (!orchId) {
      return { kind: "noop", status: "no orchestrator ID on this event" };
    }
    return {
      kind: "pivot",
      pivot: { type: "orch", id: orchId },
      status: `scoped to orchestrator ${orchId}`,
    };
  }

  // key === "t"
  if (!selectedEvent.traceId) {
    return { kind: "noop", status: "no trace ID on this event" };
  }
  return {
    kind: "pivot",
    pivot: { type: "trace", id: selectedEvent.traceId },
    status: `scoped to trace ${selectedEvent.traceId.slice(0, 16)}…`,
  };
}
