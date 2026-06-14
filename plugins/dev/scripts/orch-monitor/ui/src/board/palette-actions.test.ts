// palette-actions.test.ts — units for the pure ⌘K command-list builder
// (CTL-916 / DETAIL5). Encodes every Gherkin scenario for the palette:
//
//   - ⌘K lists GO TO TICKET / GO TO WORKER / RECENT from the resident payload,
//     and a genuinely-live row carries the cyan-live flag (cyan never on a settled
//     row → that's a skin concern proven via `live`).
//   - A focused worker offers Copy session id / Copy bg_job_id / Tail in Loki /
//     Open PR / Next-prev stuck worker.
//   - Write-actions (Stop worker) + Linear search render disabled with `soon`.
//
// Pure imports only (no DOM, no cmdk) — runs under `cd ui && bun test`.
import { describe, it, expect } from "bun:test";
import {
  buildPaletteGroups,
  lokiTailUrl,
  type PaletteFocus,
  type PaletteGroup,
  type PaletteItem,
} from "./palette-actions";
import type { BoardPayload, BoardTicket, BoardWorker } from "./types";

// ── fixtures ─────────────────────────────────────────────────────────────────
function ticket(over: Partial<BoardTicket> & Pick<BoardTicket, "id">): BoardTicket {
  return {
    title: `${over.id} title`,
    type: "feature",
    repo: "catalyst",
    team: "CTL",
    phase: "implement",
    status: "running",
    model: "opus",
    linearState: "Implement",
    workerStatus: null,
    activeState: null,
    working: false,
    lastActiveMs: null,
    priority: 2,
    estimate: 3,
    scope: "M",
    project: null,
    costUSD: null,
    tokens: null,
    turns: null,
    phaseCosts: null,
    phaseSummary: [],
    pr: null,
    updatedAt: "now",
    ...over,
  };
}

function worker(over: Partial<BoardWorker> & Pick<BoardWorker, "name">): BoardWorker {
  return {
    ticket: over.name.split(":")[0],
    tickets: [],
    phase: "implement",
    status: "running",
    activeState: null,
    working: false,
    lastActiveMs: null,
    repo: "catalyst",
    team: "CTL",
    runtimeMs: 60000,
    costUSD: null,
    ...over,
  };
}

function payload(over: Partial<BoardPayload> = {}): BoardPayload {
  return {
    generatedAt: "now",
    config: { maxParallel: 4, inFlight: 0, freeSlots: 4, active: 0, working: 0, stuck: 0 },
    repos: ["catalyst"],
    workers: [],
    tickets: [],
    queue: [],
    ...over,
  };
}

function group(groups: PaletteGroup[], heading: string): PaletteGroup | undefined {
  return groups.find((g) => g.heading.toLowerCase() === heading.toLowerCase());
}

function item(groups: PaletteGroup[], id: string): PaletteItem | undefined {
  return groups.flatMap((g) => g.items).find((i) => i.id === id);
}

const NO_FOCUS: PaletteFocus = { kind: "none" };

// ── Scenario: ⌘K lists GO TO groups + RECENT over resident data ──────────────
describe("buildPaletteGroups — GO TO TICKET / WORKER / RECENT over resident payload", () => {
  it("lists every board ticket under GO TO TICKET with a navigate action", () => {
    const p = payload({ tickets: [ticket({ id: "CTL-845" }), ticket({ id: "CTL-877" })] });
    const groups = buildPaletteGroups(p, NO_FOCUS, []);
    const g = group(groups, "Go to ticket")!;
    expect(g.items.map((i) => i.id)).toEqual(["goto-ticket:CTL-845", "goto-ticket:CTL-877"]);
    expect(g.items[0].action).toEqual({ type: "navigate", to: "/ticket/$id", id: "CTL-845" });
  });

  it("lists every live worker under GO TO WORKER with a navigate action", () => {
    const p = payload({ workers: [worker({ name: "CTL-845:2" })] });
    const groups = buildPaletteGroups(p, NO_FOCUS, []);
    const g = group(groups, "Go to worker")!;
    expect(g.items.map((i) => i.id)).toEqual(["goto-worker:CTL-845:2"]);
    expect(g.items[0].action).toEqual({ type: "navigate", to: "/worker/$id", id: "CTL-845:2" });
  });

  it("resolves RECENT ids back to their resident entity, most-recent-first", () => {
    const p = payload({
      tickets: [ticket({ id: "CTL-831", title: "compound estimate" })],
      workers: [worker({ name: "CTL-845:2", phase: "implement" })],
    });
    const groups = buildPaletteGroups(p, NO_FOCUS, ["CTL-845:2", "CTL-831"]);
    const g = group(groups, "Recent")!;
    expect(g.items.map((i) => i.id)).toEqual(["recent:CTL-845:2", "recent:CTL-831"]);
    // a recent worker id navigates to /worker, a recent ticket id to /ticket
    expect(g.items[0].action).toEqual({ type: "navigate", to: "/worker/$id", id: "CTL-845:2" });
    expect(g.items[1].action).toEqual({ type: "navigate", to: "/ticket/$id", id: "CTL-831" });
  });

  it("an off-board recent id still navigates (no fabricated live glyph)", () => {
    const p = payload({ tickets: [] });
    const groups = buildPaletteGroups(p, NO_FOCUS, ["CTL-999"]);
    const r = item(groups, "recent:CTL-999")!;
    expect(r.action).toEqual({ type: "navigate", to: "/ticket/$id", id: "CTL-999" });
    expect(r.live).toBe(false);
  });
});

// ── Scenario: the cyan live glyph rides ONLY a genuinely-live row ────────────
describe("buildPaletteGroups — cyan live glyph (working && active) only", () => {
  it("flags a working+active ticket row live, and never a settled one", () => {
    const p = payload({
      tickets: [
        ticket({ id: "CTL-LIVE", working: true, activeState: "active" }),
        ticket({ id: "CTL-DONE", working: false, activeState: null }),
        ticket({ id: "CTL-STUCK", working: false, activeState: "stuck" }),
      ],
    });
    const groups = buildPaletteGroups(p, NO_FOCUS, []);
    expect(item(groups, "goto-ticket:CTL-LIVE")!.live).toBe(true);
    expect(item(groups, "goto-ticket:CTL-DONE")!.live).toBe(false);
    // stuck is NOT live (cyan is the in-loop signal, not the stuck signal)
    expect(item(groups, "goto-ticket:CTL-STUCK")!.live).toBe(false);
  });

  it("active-but-not-working does not earn the live glyph (the conjunction)", () => {
    const p = payload({
      workers: [worker({ name: "CTL-1:1", working: false, activeState: "active" })],
    });
    const groups = buildPaletteGroups(p, NO_FOCUS, []);
    expect(item(groups, "goto-worker:CTL-1:1")!.live).toBe(false);
  });
});

// ── Scenario: Copy and Loki actions fire when a worker is focused ────────────
describe("buildPaletteGroups — focused worker offers copy / Loki / Open PR / stuck-walk", () => {
  const p = payload({
    tickets: [ticket({ id: "CTL-845", pr: 1487 })],
    workers: [
      worker({ name: "CTL-845:2", ticket: "CTL-845", sessionId: "uuid-abc" }),
      worker({ name: "CTL-844:1", ticket: "CTL-844", activeState: "stuck" }),
      worker({ name: "CTL-843:1", ticket: "CTL-843", activeState: "stuck" }),
    ],
  });
  const focus: PaletteFocus = { kind: "worker", id: "CTL-845:2" };
  const groups = buildPaletteGroups(p, focus, []);

  it("offers Copy session id from the resident BoardWorker.sessionId", () => {
    const copy = item(groups, "copy-session-id")!;
    expect(copy.disabled).toBeFalsy();
    expect(copy.action).toEqual({ type: "copy", value: "uuid-abc" });
  });

  it("offers Tail in Loki with the verified session_id metadata-pipe LogQL", () => {
    const loki = item(groups, "tail-loki")!;
    expect(loki.disabled).toBeFalsy();
    expect(loki.action?.type).toBe("open-url");
    const url = (loki.action as { type: "open-url"; url: string }).url;
    const left = new URL(url, "http://x").searchParams.get("left")!;
    // `left` is the Grafana-Explore JSON [range, range, datasource, {expr}].
    const expr = (JSON.parse(left) as [string, string, string, { expr: string }])[3].expr;
    // the LogQL pipes session_id as structured metadata, not a stream-label matcher
    expect(expr).toContain('{service_name="claude-code"}');
    expect(expr).toContain("session_id=`uuid-abc`");
    expect(expr).not.toContain("{session_id=");
  });

  it("offers Open PR resolved from the parent ticket's pr", () => {
    const pr = item(groups, "open-pr")!;
    expect(pr.meta).toBe("#1487");
    expect(pr.action?.type).toBe("open-url");
  });

  it("offers Next / prev stuck worker navigations", () => {
    // focused worker is not stuck → next = first stuck, prev = last stuck
    expect(item(groups, "next-stuck")!.action).toEqual({
      type: "navigate",
      to: "/worker/$id",
      id: "CTL-844:1",
    });
    expect(item(groups, "prev-stuck")!.action).toEqual({
      type: "navigate",
      to: "/worker/$id",
      id: "CTL-843:1",
    });
  });

  it("Copy bg_job_id renders disabled with `soon` (lives in the phase signal, not BoardWorker)", () => {
    const bg = item(groups, "copy-bg-job-id")!;
    expect(bg.disabled).toBe(true);
    expect(bg.soon).toBe(true);
    expect(bg.action).toBeUndefined();
  });
});

// ── Scenario: write-actions + Linear search render honestly disabled ─────────
describe("buildPaletteGroups — honesty pattern (disabled `soon`, never activatable)", () => {
  it("always renders Search all tickets in Linear disabled with `soon`", () => {
    const groups = buildPaletteGroups(payload(), NO_FOCUS, []);
    const search = item(groups, "linear-search")!;
    expect(search.disabled).toBe(true);
    expect(search.soon).toBe(true);
    expect(search.action).toBeUndefined();
  });

  it("renders ⛔ Stop worker disabled with `soon` when a worker is focused", () => {
    const p = payload({ workers: [worker({ name: "CTL-845:2" })] });
    const groups = buildPaletteGroups(p, { kind: "worker", id: "CTL-845:2" }, []);
    const stop = item(groups, "stop-worker")!;
    expect(stop.disabled).toBe(true);
    expect(stop.soon).toBe(true);
    expect(stop.action).toBeUndefined();
  });

  it("does not show Stop worker when no worker is focused", () => {
    const groups = buildPaletteGroups(payload(), NO_FOCUS, []);
    expect(item(groups, "stop-worker")).toBeUndefined();
  });

  it("every disabled row is non-activatable (no action) — never a dead live action", () => {
    const p = payload({ workers: [worker({ name: "CTL-845:2" })] });
    const groups = buildPaletteGroups(p, { kind: "worker", id: "CTL-845:2" }, []);
    for (const i of groups.flatMap((g) => g.items)) {
      if (i.disabled) expect(i.action).toBeUndefined();
    }
  });
});

// ── empty-group + Loki-url unit hygiene ──────────────────────────────────────
describe("buildPaletteGroups — empty groups dropped; soon group always present", () => {
  it("drops empty GO TO / RECENT groups but keeps the disabled honesty group", () => {
    const groups = buildPaletteGroups(payload(), NO_FOCUS, []);
    expect(group(groups, "Go to ticket")).toBeUndefined();
    expect(group(groups, "Go to worker")).toBeUndefined();
    expect(group(groups, "Recent")).toBeUndefined();
    expect(group(groups, "Needs plumbing")).toBeDefined();
  });
});

describe("lokiTailUrl", () => {
  it("respects a custom grafana base", () => {
    const url = lokiTailUrl("uuid-xyz", "https://grafana.example/explore");
    expect(url.startsWith("https://grafana.example/explore?")).toBe(true);
  });
});

// ── CTL-1025: PaletteItem.keybinding field ───────────────────────────────────
describe("PaletteItem — optional keybinding field (CTL-1025)", () => {
  it("carries an optional keybinding onto rows that have one", () => {
    const item: PaletteItem = { id: "nav.surface.board", label: "Go to Tickets", keybinding: "g b" };
    expect(item.keybinding).toBe("g b");
  });
  it("keybinding is optional — rows without one compile and work", () => {
    const item: PaletteItem = { id: "copy-session-id", label: "Copy session id" };
    expect(item.keybinding).toBeUndefined();
  });
});
