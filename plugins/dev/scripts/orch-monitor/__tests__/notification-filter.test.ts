import { describe, it, expect } from "bun:test";
import {
  shouldNotify,
  createNotificationProjector,
} from "../lib/notification-filter";

describe("shouldNotify (template parity with lib.rs)", () => {
  it("needs-human ticket → '{id} needs your decision' + humanQuestion body + deep link", () => {
    expect(
      shouldNotify({
        kind: "ticket",
        id: "CTL-9",
        attention: "needs-human",
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
        attention: "needs-human",
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
      attention: "needs-human" | "waiting-on-you" | null;
      attentionSince?: string | null;
      humanQuestion?: string;
      title?: string;
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
          { id: "CTL-1", attention: "needs-human", attentionSince: "s1" },
        ],
      }),
    );
    expect(out.map((n) => n.title)).toEqual(["CTL-1 needs your decision"]);
  });

  it("does not re-fire the same ticket attention episode", () => {
    const p = createNotificationProjector();
    const t = [
      { id: "CTL-1", attention: "needs-human" as const, attentionSince: "s1" },
    ];
    p.project(board({ tickets: t }));
    expect(p.project(board({ tickets: t }))).toEqual([]);
  });

  it("re-fires when attentionSince changes (new episode)", () => {
    const p = createNotificationProjector();
    p.project(
      board({
        tickets: [{ id: "CTL-1", attention: "needs-human", attentionSince: "s1" }],
      }),
    );
    const out = p.project(
      board({
        tickets: [{ id: "CTL-1", attention: "needs-human", attentionSince: "s2" }],
      }),
    );
    expect(out).toHaveLength(1);
  });

  it("daemon transition healthy→offline fires once, not on the steady state", () => {
    const p = createNotificationProjector();
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
