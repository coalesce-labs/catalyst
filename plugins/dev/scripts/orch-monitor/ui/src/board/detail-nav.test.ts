// detail-nav.test.ts — CTL-942 acceptance guards for the card→detail-page
// navigation wiring.
//
// `bun test` has no DOM, so — matching the established app-shell.test.ts /
// board-todo-column.test.ts pattern — the pure helpers are unit-tested
// directly and the load-bearing JSX wiring (cards intercept the new-tab
// gesture; the drawer header carries a real <a href> Open affordance) is
// asserted by static source analysis.
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  ticketDetailHref,
  workerDetailHref,
  isNewTabClick,
} from "./detail-nav";

const HERE = dirname(fileURLToPath(import.meta.url));
const boardSrc = readFileSync(join(HERE, "Board.tsx"), "utf8");
const drawerSrc = readFileSync(
  join(HERE, "..", "components", "ticket-detail-drawer.tsx"),
  "utf8",
);

describe("detail-page hrefs (CTL-942)", () => {
  it("builds /ticket/$id and /worker/$id paths the server SPA fallback answers", () => {
    expect(ticketDetailHref("CTL-845")).toBe("/ticket/CTL-845");
    expect(workerDetailHref("CTL-845:2")).toBe("/worker/CTL-845%3A2");
  });

  it("encodes ids so a weird segment can never escape the route", () => {
    expect(ticketDetailHref("a/b")).toBe("/ticket/a%2Fb");
  });
});

describe("isNewTabClick gesture (CTL-942)", () => {
  const click = (over: Partial<{ metaKey: boolean; ctrlKey: boolean; button: number }>) => ({
    metaKey: false,
    ctrlKey: false,
    button: 0,
    ...over,
  });

  it("recognises cmd-click, ctrl-click, and middle-click", () => {
    expect(isNewTabClick(click({ metaKey: true }))).toBe(true);
    expect(isNewTabClick(click({ ctrlKey: true }))).toBe(true);
    expect(isNewTabClick(click({ button: 1 }))).toBe(true);
  });

  it("leaves the plain primary click to the drawer/select path", () => {
    expect(isNewTabClick(click({}))).toBe(false);
  });
});

describe("board card wiring (static source, CTL-942)", () => {
  it("ticket cards intercept the new-tab gesture and deep-link to /ticket/$id", () => {
    expect(boardSrc).toContain("isNewTabClick");
    expect(boardSrc).toContain("ticketDetailHref(t.id)");
  });

  it("worker cards deep-link to /worker/$id with the same gesture", () => {
    expect(boardSrc).toContain("workerDetailHref(w.name)");
  });

  it("middle-click is wired via onAuxClick on both cards", () => {
    const auxCount = boardSrc.split("onAuxClick").length - 1;
    expect(auxCount).toBeGreaterThanOrEqual(2);
  });
});

describe("drawer Open affordance (static source, CTL-942)", () => {
  it("renders a real anchor to the full ticket page (browser navigation crosses entries)", () => {
    expect(drawerSrc).toContain("ticketDetailHref(ticket.id)");
    // It must be an <a href>, not a router push — the drawer also mounts in the
    // router-less shell entry, so only a hard navigation reaches the detail page.
    expect(drawerSrc).toMatch(/<a\s[^>]*href=\{ticketDetailHref\(ticket\.id\)\}/);
  });
});
