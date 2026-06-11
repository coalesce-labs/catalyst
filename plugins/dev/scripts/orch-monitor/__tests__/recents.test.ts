// recents.test.ts — units for the recency-merge behind the ⌘K RECENT group +
// `recentlyViewedAtom` persistence (CTL-882 / FND2). Tests the PURE helper
// ui/src/board/recents.ts (jotai-free), so they run in the main `bun test`
// suite without a jotai / localStorage runtime — the atom wiring in nav-store.ts
// calls this exact helper, so the persisted list can't drift from these units.
//
// Encodes the FND2 Gherkin "Recently-viewed survives a reload": visit CTL-845
// then CTL-831 then reload → recentlyViewedAtom still lists CTL-831 and CTL-845
// in recency order. atomWithStorage handles the literal localStorage round-trip
// (asserted from the ui module graph in nav-store.test.ts); what makes the
// reload *correct* is that `pushRecent` keeps the list most-recent-first and
// de-duped, which is what these units lock in.
import { describe, it, expect } from "bun:test";
import { pushRecent, RECENTLY_VIEWED_CAP, RECENTLY_VIEWED_KEY } from "../ui/src/board/recents";

describe("pushRecent — recency-order merge (CTL-882)", () => {
  it("seeds an empty list with the first visit", () => {
    expect(pushRecent([], "CTL-845")).toEqual(["CTL-845"]);
  });

  it("puts the most-recent visit at the front", () => {
    // visit CTL-845 then CTL-831 → ["CTL-831", "CTL-845"] (recency order).
    const afterFirst = pushRecent([], "CTL-845");
    const afterSecond = pushRecent(afterFirst, "CTL-831");
    expect(afterSecond).toEqual(["CTL-831", "CTL-845"]);
  });

  it("re-visiting an id moves it to the front without duplicating", () => {
    const list = pushRecent(pushRecent([], "CTL-845"), "CTL-831"); // [831, 845]
    const revisit = pushRecent(list, "CTL-845");
    expect(revisit).toEqual(["CTL-845", "CTL-831"]);
    // exactly one occurrence of each id.
    expect(revisit.filter((x) => x === "CTL-845")).toHaveLength(1);
  });

  it("ignores an empty id so a cold-link never pollutes recents", () => {
    const list = ["CTL-845"];
    expect(pushRecent(list, "")).toEqual(["CTL-845"]);
  });

  it("caps the list at the cap, dropping the oldest", () => {
    let list: string[] = [];
    for (let i = 0; i < RECENTLY_VIEWED_CAP + 5; i++) list = pushRecent(list, `CTL-${i}`);
    expect(list).toHaveLength(RECENTLY_VIEWED_CAP);
    // newest first, oldest dropped.
    expect(list[0]).toBe(`CTL-${RECENTLY_VIEWED_CAP + 4}`);
    expect(list).not.toContain("CTL-0");
  });

  it("respects an explicit small cap", () => {
    const list = pushRecent(pushRecent(pushRecent([], "a"), "b"), "c");
    expect(pushRecent(list, "d", 2)).toEqual(["d", "c"]);
  });

  it("never mutates the input list", () => {
    const orig = ["CTL-845"];
    const copy = [...orig];
    pushRecent(orig, "CTL-831");
    expect(orig).toEqual(copy);
  });

  it("exposes a stable, namespaced storage key", () => {
    expect(RECENTLY_VIEWED_KEY).toBe("catalyst.recentlyViewed");
  });
});

// The "survives a reload" simulation in pure form: persist the merged list (what
// atomWithStorage writes to localStorage), then re-derive it on the next load —
// the order must hold. The real localStorage round-trip is covered by
// nav-store.test.ts in the ui module graph.
describe("pushRecent — survives a (simulated) reload (CTL-882)", () => {
  it("the persisted list is already in recency order on reload", () => {
    // session 1: visit CTL-845 then CTL-831.
    let persisted = pushRecent([], "CTL-845");
    persisted = pushRecent(persisted, "CTL-831");
    const serialized = JSON.stringify(persisted); // what localStorage holds

    // reload: atomWithStorage reads the same bytes back.
    const rehydrated: string[] = JSON.parse(serialized);
    expect(rehydrated).toEqual(["CTL-831", "CTL-845"]);
  });
});
