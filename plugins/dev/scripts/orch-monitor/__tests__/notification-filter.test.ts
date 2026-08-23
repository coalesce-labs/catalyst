import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  shouldNotify,
  createNotificationProjector,
  resolveDaemonNotifyHoldMs,
} from "../lib/notification-filter";

describe("shouldNotify (template parity with lib.rs)", () => {
  it("ask ticket → '{id} needs your decision' + humanQuestion body + deep link", () => {
    expect(
      shouldNotify({
        kind: "ticket",
        id: "CTL-9",
        attention: "ask",
        humanQuestion: "Approve plan?",
        title: "T",
      }),
    ).toEqual({
      title: "CTL-9 needs your decision",
      body: "Approve plan?",
      deepLink: "/?ticket=CTL-9",
    });
  });

  it("waiting-on-you ticket → '{id} is waiting on you'", () => {
    expect(
      shouldNotify({
        kind: "ticket",
        id: "CTL-9",
        attention: "waiting-on-you",
        humanQuestion: "",
        title: "Fix the thing",
      }),
    ).toEqual({
      title: "CTL-9 is waiting on you",
      body: "Fix the thing",
      deepLink: "/?ticket=CTL-9",
    });
  });

  it("body falls back humanQuestion → title → 'needs your attention'", () => {
    expect(
      shouldNotify({
        kind: "ticket",
        id: "CTL-9",
        attention: "ask",
        humanQuestion: "",
        title: "",
      })?.body,
    ).toBe("needs your attention");
  });

  it("attention === null ticket → null (not notify-worthy)", () => {
    expect(
      shouldNotify({ kind: "ticket", id: "CTL-9", attention: null }),
    ).toBeNull();
  });

  // CAT-170: one correlated incident → ONE alert. Members are labeled/rendered
  // normally; only their push is suppressed so the anchor speaks for the group.
  it("correlated MEMBER ticket → suppressed (the anchor carries the alert)", () => {
    expect(
      shouldNotify({
        kind: "ticket",
        id: "CTL-11",
        attention: "ask",
        humanQuestion: "Approve plan?",
        correlationRole: "member",
      }),
    ).toBeNull();
  });

  it("correlated ANCHOR ticket → still notifies", () => {
    expect(
      shouldNotify({
        kind: "ticket",
        id: "CTL-10",
        attention: "ask",
        humanQuestion: "Approve plan?",
        correlationRole: "anchor",
      }),
    ).toEqual({
      title: "CTL-10 needs your decision",
      body: "Approve plan?",
      deepLink: "/?ticket=CTL-10",
    });
  });

  it("uncorrelated singleton (no role) → notifies as before", () => {
    expect(
      shouldNotify({
        kind: "ticket",
        id: "CTL-12",
        attention: "ask",
        humanQuestion: "Approve plan?",
        correlationRole: null,
      }),
    ).toEqual({
      title: "CTL-12 needs your decision",
      body: "Approve plan?",
      deepLink: "/?ticket=CTL-12",
    });
  });

  it("daemon → healthy → 'Catalyst — daemon recovered'", () => {
    expect(shouldNotify({ kind: "daemon", to: "healthy" })).toEqual({
      title: "Catalyst — daemon recovered",
      body: "Fleet daemon is healthy again",
      deepLink: "/",
    });
  });

  it("daemon → degraded/offline → 'Catalyst — daemon degraded' + 'Daemon state: {to}'", () => {
    expect(shouldNotify({ kind: "daemon", to: "offline" })).toEqual({
      title: "Catalyst — daemon degraded",
      body: "Daemon state: offline",
      deepLink: "/",
    });
  });

  it("anomaly rising → 'Catalyst — board anomaly'", () => {
    expect(shouldNotify({ kind: "anomaly" })).toEqual({
      title: "Catalyst — board anomaly",
      body: "A board anomaly was detected — take a look",
      deepLink: "/",
    });
  });
});

describe("createNotificationProjector (edge detection + dedup)", () => {
  const board = (over: Record<string, unknown> = {}) => ({
    tickets: [] as Array<{
      id: string;
      attention: "ask" | "waiting-on-you" | null;
      attentionSince?: string | null;
      humanQuestion?: string;
      title?: string;
      correlationRole?: string | null;
    }>,
    daemon: "healthy" as "healthy" | "degraded" | "offline",
    anomaly: false,
    generatedAt: "t0",
    ...over,
  });

  it("first frame: emits attention tickets but NO daemon/anomaly events (no prior state)", () => {
    const p = createNotificationProjector();
    const out = p.project(
      board({
        tickets: [
          { id: "CTL-1", attention: "ask", attentionSince: "s1" },
        ],
      }),
    );
    expect(out.map((n) => n.title)).toEqual(["CTL-1 needs your decision"]);
  });

  // CAT-170 regression pin: THE bug this ticket exists to fix. A three-ticket
  // correlated incident used to produce three separate operator pushes because the
  // projector keys purely on ticket id. Exactly one alert — the anchor's — now escapes.
  it("a 3-ticket correlated incident emits exactly ONE alert (the anchor's)", () => {
    const p = createNotificationProjector();
    const out = p.project(
      board({
        tickets: [
          { id: "CTL-1", attention: "ask", attentionSince: "s1", correlationRole: "anchor" },
          { id: "CTL-2", attention: "ask", attentionSince: "s1", correlationRole: "member" },
          { id: "CTL-3", attention: "ask", attentionSince: "s1", correlationRole: "member" },
        ],
      }),
    );
    expect(out.map((n) => n.title)).toEqual(["CTL-1 needs your decision"]);
  });

  // CAT-170 (Codex #3209 round-3 P1): the suppression above only works if the role
  // actually REACHES the projector. server.ts's `toProjectorBoard` rebuilds each
  // ticket field-by-field, and both server notification paths (SSE + web push) go
  // through it — so an omitted `correlationRole` there silently re-broke the feature
  // one layer below these tests, which construct ProjectorBoard tickets directly and
  // therefore cannot catch it. Pin the adapter's forwarding at the source level
  // (same technique as the broker namespace-parity source-scan).
  it("server.ts's toProjectorBoard forwards correlationRole to the projector", () => {
    const src = readFileSync(join(import.meta.dir, "..", "server.ts"), "utf8");
    const start = src.indexOf("const toProjectorBoard");
    expect(start).toBeGreaterThan(-1);
    const mapping = src.slice(start, src.indexOf("daemon: nav.daemon", start));
    expect(mapping).toContain("correlationRole");
  });

  it("a suppressed member still notifies later if it becomes its own anchor", () => {
    const p = createNotificationProjector();
    p.project(
      board({
        tickets: [
          { id: "CTL-2", attention: "ask", attentionSince: "s1", correlationRole: "member" },
        ],
      }),
    );
    // Same episode, now promoted to anchor: suppression must not have latched the
    // dedup key (fired.add only runs on a real emit), so the alert still lands.
    const out = p.project(
      board({
        tickets: [
          { id: "CTL-2", attention: "ask", attentionSince: "s1", correlationRole: "anchor" },
        ],
      }),
    );
    expect(out.map((n) => n.title)).toEqual(["CTL-2 needs your decision"]);
  });

  it("does not re-fire the same ticket attention episode", () => {
    const p = createNotificationProjector();
    const t = [
      { id: "CTL-1", attention: "ask" as const, attentionSince: "s1" },
    ];
    p.project(board({ tickets: t }));
    expect(p.project(board({ tickets: t }))).toEqual([]);
  });

  it("re-fires when attentionSince changes (new episode)", () => {
    const p = createNotificationProjector();
    p.project(
      board({
        tickets: [{ id: "CTL-1", attention: "ask", attentionSince: "s1" }],
      }),
    );
    const out = p.project(
      board({
        tickets: [{ id: "CTL-1", attention: "ask", attentionSince: "s2" }],
      }),
    );
    expect(out).toHaveLength(1);
  });

  it("daemon transition healthy→offline fires once, not on the steady state", () => {
    // CTL-1522: with the hold, an immediate-edge assertion needs the clock to
    // advance past it. holdMs=0 disables the hold so the escalation is observed
    // on its own frame. Note 0 is "no hold", not a byte-identical rollback —
    // seed-announce and orphan-recovery suppression are unconditional. See the
    // daemonNotifyHoldMs docstring (Codex P2, #2739).
    const p = createNotificationProjector({ daemonNotifyHoldMs: 0 });
    p.project(board({ daemon: "healthy" })); // establishes prev
    const a = p.project(board({ daemon: "offline" }));
    const b = p.project(board({ daemon: "offline" }));
    expect(a).toHaveLength(1);
    expect(b).toEqual([]);
  });

  it("anomaly fires only on the false→true rising edge", () => {
    const p = createNotificationProjector();
    p.project(board({ anomaly: false }));
    expect(p.project(board({ anomaly: true }))).toHaveLength(1);
    expect(p.project(board({ anomaly: true }))).toEqual([]); // stays true: no re-fire
    p.project(board({ anomaly: false }));
    expect(p.project(board({ anomaly: true }))).toHaveLength(1); // new rising edge
  });
});

// CTL-1522: the daemon branch used to be a naked edge trigger — every flip of
// the heartbeat-freshness signal pushed, in BOTH directions, with no dedupe.
// Measured on mini: 1,100 heartbeat gaps >90s in July and ZERO >300s, i.e. the
// daemon never actually died yet ~300 phone pushes/day went out. These pin the
// sustained-hold behavior that replaced it.
describe("createNotificationProjector — daemon notify hold (CTL-1522)", () => {
  const HOLD = 180_000;

  /** Projector driven by an explicit clock the test advances by hand. */
  const harness = (holdMs = HOLD) => {
    let clock = 1_000_000;
    const p = createNotificationProjector({
      now: () => clock,
      daemonNotifyHoldMs: holdMs,
    });
    return {
      /** Advance the clock, project one frame, return the notification titles. */
      at(deltaMs: number, daemon: "healthy" | "degraded" | "offline") {
        clock += deltaMs;
        return p.project({ daemon }).map((n) => n.title);
      },
      /** Advance the clock, project one frame, return the full notifications. */
      full(deltaMs: number, daemon: "healthy" | "degraded" | "offline") {
        clock += deltaMs;
        return p.project({ daemon });
      },
    };
  };

  it("first frame seeds silently even when already degraded", () => {
    const h = harness();
    expect(h.at(0, "degraded")).toEqual([]);
  });

  it("a sub-hold degraded blip pushes nothing in EITHER direction", () => {
    // The 1,100-gaps case: a ~46s excursion past the 90s freshness window.
    const h = harness();
    h.at(0, "healthy");
    expect(h.at(90_000, "degraded")).toEqual([]);
    expect(h.at(46_000, "healthy")).toEqual([]);
    // and no orphan "recovered" on any later steady-state frame either
    expect(h.at(600_000, "healthy")).toEqual([]);
  });

  it("sustained degraded pushes exactly once, at hold expiry", () => {
    const h = harness();
    h.at(0, "healthy");
    h.at(1, "degraded"); // anchor
    expect(h.at(HOLD - 1, "degraded")).toEqual([]); // one tick short
    expect(h.at(1, "degraded")).toEqual(["Catalyst — daemon degraded"]);
    expect(h.at(1, "degraded")).toEqual([]); // steady state: no repeat
    expect(h.at(600_000, "degraded")).toEqual([]);
  });

  it("REGRESSION GUARD: a mid-hold degraded→offline escalation does not restart the clock", () => {
    // If the hold anchored on the exact value instead of healthy-vs-not, this
    // push would slide out to HOLD after the escalation and a real death would
    // be announced late.
    const h = harness();
    h.at(0, "healthy");
    h.at(1, "degraded"); // anchor here
    expect(h.at(110_000, "offline")).toEqual([]); // escalated mid-hold
    const out = h.full(HOLD - 110_000, "offline"); // hold measured from the ANCHOR
    expect(out.map((n) => n.title)).toEqual(["Catalyst — daemon degraded"]);
    expect(out[0]?.body).toBe("Daemon state: offline");
  });

  it("a real death escalates to offline once the escalation clears its own hold", () => {
    // Heartbeat stops: board reads degraded at 90s (anchor) and the degraded
    // push — the one that actually wakes a human — fires at 270s. The board
    // reads offline at 300s; that refinement is held on its OWN value so a
    // transient offline frame cannot buzz (Codex P2), landing at 300s + HOLD.
    const h = harness();
    h.at(0, "healthy");
    h.at(90_000, "degraded");
    expect(h.at(HOLD, "degraded")).toEqual(["Catalyst — daemon degraded"]);
    h.at(30_000, "offline"); // value anchor for the escalation
    expect(h.at(HOLD - 1, "offline")).toEqual([]); // still holding
    const out = h.full(1, "offline");
    expect(out.map((n) => n.title)).toEqual(["Catalyst — daemon degraded"]);
    expect(out[0]?.body).toBe("Daemon state: offline");
    expect(h.at(1, "offline")).toEqual([]); // escalates exactly once
  });

  it("a transient offline frame inside an announced episode does NOT buzz again", () => {
    // Codex P2 (#2739): healthy → degraded past the hold → ONE offline frame
    // (the productionDaemonHealth bare-catch path) → back to degraded. The
    // offline must not push, because the transient never persisted.
    const h = harness();
    h.at(0, "healthy");
    h.at(1, "degraded");
    expect(h.at(HOLD, "degraded")).toEqual(["Catalyst — daemon degraded"]);
    expect(h.at(3_000, "offline")).toEqual([]); // single spurious frame
    expect(h.at(3_000, "degraded")).toEqual([]); // and back — still silent
    expect(h.at(600_000, "degraded")).toEqual([]);
  });

  it("de-escalation offline→degraded does not buzz", () => {
    const h = harness();
    h.at(0, "healthy");
    h.at(1, "offline");
    expect(h.at(HOLD, "offline")).toEqual(["Catalyst — daemon degraded"]);
    expect(h.at(1, "degraded")).toEqual([]); // improving: silent
  });

  it("recovery fires only after a degraded actually fired, and only once", () => {
    const h = harness();
    h.at(0, "healthy");
    h.at(1, "degraded");
    expect(h.at(HOLD, "degraded")).toEqual(["Catalyst — daemon degraded"]);
    h.at(1, "healthy"); // recovery anchor
    expect(h.at(HOLD - 1, "healthy")).toEqual([]); // still holding
    expect(h.at(1, "healthy")).toEqual(["Catalyst — daemon recovered"]);
    expect(h.at(600_000, "healthy")).toEqual([]); // no repeat
  });

  it("a spurious one-frame offline (the bare-catch path) is absorbed", () => {
    // productionDaemonHealth returns "offline" from a bare catch, so any
    // transient heartbeat-read throw used to be an instant push.
    const h = harness();
    h.at(0, "healthy");
    expect(h.at(3_000, "offline")).toEqual([]);
    expect(h.at(3_000, "healthy")).toEqual([]);
  });

  it("holdMs=0 restores immediate-edge escalation", () => {
    const h = harness(0);
    h.at(0, "healthy");
    expect(h.at(1, "degraded")).toEqual(["Catalyst — daemon degraded"]);
    expect(h.at(1, "healthy")).toEqual(["Catalyst — daemon recovered"]);
  });

  it("defaults to the module hold when no option is passed", () => {
    // Guards the production call path: server.ts passes undefined when the env
    // knob is unset, which must NOT collapse to 0.
    const p = createNotificationProjector();
    p.project({ daemon: "healthy" });
    expect(p.project({ daemon: "degraded" })).toEqual([]);
  });
});

// Codex P2 (#2739): a bare Number(env) coerces "" to 0 and accepts negatives,
// either of which silently disables the hold and restores the storm. Mirrors
// resolveRestoreHoldMs (execution-core/config.mjs), which exists because
// CTL-1091 hit exactly this trap.
describe("resolveDaemonNotifyHoldMs (CTL-1522)", () => {
  it("falls back to the default for unset / blank / non-numeric / negative", () => {
    for (const raw of [undefined, "", "   ", "\t", "abc", "-1", "-0.5", "NaN", "Infinity"]) {
      expect(resolveDaemonNotifyHoldMs(raw)).toBeUndefined();
    }
  });

  it("accepts a finite value >= 0, including an explicit 0 opt-out", () => {
    expect(resolveDaemonNotifyHoldMs("0")).toBe(0);
    expect(resolveDaemonNotifyHoldMs("180000")).toBe(180_000);
    expect(resolveDaemonNotifyHoldMs(" 240000 ")).toBe(240_000);
  });
});
