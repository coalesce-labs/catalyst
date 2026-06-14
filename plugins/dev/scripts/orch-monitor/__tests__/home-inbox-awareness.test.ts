// home-inbox-awareness.test.ts — CTL-1050 §3.2: the awareness (service-outage)
// inbox section. State-derived from the server-decorated payload.serviceHealth
// outages — one row per service, AFTER running and BEFORE done, NOT a needs-you
// section, structurally flap-proof (recovery drops the row from the next snapshot).

import { describe, it, expect } from "bun:test";
import {
  deriveInbox,
  isNeedsYouSection,
  rowDurationMs,
} from "../ui/src/board/home-inbox";
import type {
  BoardPayload,
  BoardServiceOutage,
  BoardTicket,
} from "../ui/src/board/types";

function mkTicket(id: string, over: Partial<BoardTicket> = {}): BoardTicket {
  return {
    id,
    title: `${id} title`,
    type: "feature",
    repo: "catalyst",
    team: "CTL",
    phase: "implement",
    status: "running",
    model: null,
    linearState: "In Progress",
    workerStatus: null,
    activeState: "active",
    working: true,
    lastActiveMs: 0,
    priority: 0,
    estimate: null,
    scope: null,
    project: null,
    costUSD: null,
    tokens: null,
    turns: null,
    phaseCosts: null,
    phaseSummary: [],
    pr: null,
    updatedAt: "2026-06-11T00:00:00Z",
    ...over,
  };
}

function mkPayload(
  tickets: BoardTicket[],
  outages: BoardServiceOutage[] | undefined,
): BoardPayload {
  return {
    generatedAt: "2026-06-11T00:00:00Z",
    config: { maxParallel: 6, inFlight: 1, freeSlots: 5, active: 1, working: 1, stuck: 0 },
    repos: ["catalyst"],
    workers: [],
    tickets,
    queue: [],
    ...(outages !== undefined
      ? { serviceHealth: { generatedAt: Date.now(), outages } }
      : {}),
  };
}

const lokiOutage: BoardServiceOutage = {
  id: "loki",
  label: "Loki",
  downSince: Date.parse("2026-06-11T14:32:00"),
  detail: "Loki is unreachable since 14:32 — telemetry views degraded",
};

describe("awareness section placement + ordering", () => {
  it("renders the awareness section AFTER running and BEFORE done", () => {
    const model = deriveInbox(
      mkPayload(
        [mkTicket("CTL-900"), mkTicket("CTL-880", { status: "done", linearState: "Done" })],
        [lokiOutage],
      ),
    );
    const kinds = model.sections.map((s) => s.kind);
    const ri = kinds.indexOf("running");
    const ai = kinds.indexOf("awareness");
    const di = kinds.indexOf("done");
    expect(ai).toBeGreaterThan(ri);
    expect(ai).toBeLessThan(di);
  });

  it("renders one row per outage with the outage copy + Awareness label", () => {
    const model = deriveInbox(mkPayload([mkTicket("CTL-900")], [lokiOutage]));
    const awareness = model.sections.find((s) => s.kind === "awareness")!;
    expect(awareness.label).toBe("Awareness");
    expect(awareness.rows).toHaveLength(1);
    expect(awareness.rows[0].id).toBe("loki");
    expect(awareness.rows[0].title).toContain("Loki is unreachable since 14:32");
    expect(awareness.rows[0].subLabel).toBe("running degraded — no action needed");
    expect(awareness.rows[0].verb).toBeNull();
  });
});

describe("awareness is NOT a needs-you section", () => {
  it("awareness excluded from needs-you classification + counts", () => {
    expect(isNeedsYouSection("awareness")).toBe(false);
    const model = deriveInbox(mkPayload([mkTicket("CTL-900")], [lokiOutage]));
    expect(model.counts.awareness).toBe(1);
    expect(model.counts.needsYou).toBe(0);
  });

  it("does not break the all-clear gate (an outage is not 'needs you')", () => {
    const model = deriveInbox(mkPayload([], [lokiOutage]));
    expect(model.counts.needsYou).toBe(0);
  });
});

describe("recovery resolves the item (no stale cards)", () => {
  it("an empty outages array drops the awareness section entirely", () => {
    const model = deriveInbox(mkPayload([mkTicket("CTL-900")], []));
    expect(model.sections.find((s) => s.kind === "awareness")).toBeUndefined();
    expect(model.counts.awareness).toBe(0);
  });

  it("absent serviceHealth (older snapshot) → no awareness section, no throw", () => {
    const model = deriveInbox(mkPayload([mkTicket("CTL-900")], undefined));
    expect(model.sections.find((s) => s.kind === "awareness")).toBeUndefined();
  });

  it("a removed outage drops its row on the next snapshot (one row per service)", () => {
    const before = deriveInbox(
      mkPayload([mkTicket("CTL-900")], [lokiOutage, { ...lokiOutage, id: "prometheus", label: "Prometheus" }]),
    );
    expect(before.sections.find((s) => s.kind === "awareness")!.rows).toHaveLength(2);
    const after = deriveInbox(mkPayload([mkTicket("CTL-900")], [lokiOutage]));
    const awarenessAfter = after.sections.find((s) => s.kind === "awareness")!;
    expect(awarenessAfter.rows.map((r) => r.id)).toEqual(["loki"]);
  });
});

describe("awareness row duration anchors to downSince", () => {
  it("rowDurationMs measures since the outage downSince", () => {
    const model = deriveInbox(mkPayload([mkTicket("CTL-900")], [lokiOutage]));
    const row = model.sections.find((s) => s.kind === "awareness")!.rows[0];
    const now = lokiOutage.downSince! + 5 * 60_000;
    expect(rowDurationMs(row, now)).toBe(5 * 60_000);
  });
});
