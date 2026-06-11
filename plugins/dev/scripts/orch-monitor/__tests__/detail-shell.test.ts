// detail-shell.test.ts — CTL-912 / DETAIL1 structural acceptance guards.
//
// `bun test` has no DOM, so — matching the existing app-shell.test.ts pattern
// (SHELL1) — the React-component Gherkin scenarios are asserted by static source
// analysis (read the .tsx/.ts as text and assert the load-bearing wiring), while
// the PURE chrome/keymap cores are unit-tested directly in detail-chrome.test.ts
// and key-nav.test.ts. Together they cover all six DETAIL1 Gherkin scenarios.
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const UI_SRC = join(HERE, "..", "ui", "src");
const read = (rel: string) => readFileSync(join(UI_SRC, rel), "utf8");

const shellSrc = read("board/Shell.tsx");
// CTL-989: the detail routes moved from the retired standalone board/router.tsx
// into the SINGLE unified app router (app-router.tsx, mounted from index.html).
const routerSrc = read("app-router.tsx");
const detailRouteSrc = read("board/detail-route.tsx");
const keyboardHookSrc = read("hooks/use-keyboard-nav.ts");
const chromeSrc = read("board/detail-chrome.ts");
// CTL-1003 §B1: the ticket Property rows moved into the floating rail cards.
const ticketRailSrc = read("board/ticket-rail.tsx");

// ── Gherkin: the shell is the chrome both detail pages mount inside ─────────
describe("Shell.tsx — the shared detail-page chrome, distinct from AppShell", () => {
  it("exports a Shell component and a DetailBody slot", () => {
    expect(shellSrc).toMatch(/export function Shell\b/);
    expect(shellSrc).toMatch(/export function DetailBody\b/);
  });

  it("is the detail-PAGE chrome, NOT the app-nav Sidebar (no AppShell/Sidebar import)", () => {
    // the two are distinct components that nest — the shell must not re-mount the
    // app frame. (it lives under board/, app-shell lives under components/.)
    expect(shellSrc).not.toMatch(/from "[^"]*app-shell"/);
    expect(shellSrc).not.toMatch(/from "[^"]*app-sidebar"/);
  });

  it("both detail routes mount the Shell (ticket + worker)", () => {
    expect(detailRouteSrc).toMatch(/<Shell\b/);
    expect(detailRouteSrc).toMatch(/export function TicketDetailRoute\b/);
    expect(detailRouteSrc).toMatch(/export function WorkerDetailRoute\b/);
    // the router wires those containers onto /ticket/$id + /worker/$id.
    expect(routerSrc).toMatch(/TicketDetailRoute/);
    expect(routerSrc).toMatch(/WorkerDetailRoute/);
    expect(routerSrc).toMatch(/path: "\/ticket\/\$id"/);
    expect(routerSrc).toMatch(/path: "\/worker\/\$id"/);
  });
});

// ── Gherkin: breadcrumb + pager are pure fns of the URL search params ───────
describe("Shell.tsx — breadcrumb + pager consume the pure derivations", () => {
  it("uses resolveBreadcrumb / resolvePager from detail-chrome (the shared list-order kin)", () => {
    expect(shellSrc).toMatch(/resolveBreadcrumb/);
    expect(shellSrc).toMatch(/resolvePager/);
  });

  it("resolves the walk list via the SHARED resolveList(ids), not a private re-sort", () => {
    // the route container resolves ids through list-order's resolveListIds — the
    // P1 keystone correctness item, so the pager order matches the board.
    expect(detailRouteSrc).toMatch(/resolveListIds/);
    expect(detailRouteSrc).toMatch(/from "\.\/list-order"/);
  });

  it("walks in place via a typed route-param swap with a ?cursor tick (no full reload)", () => {
    expect(shellSrc).toMatch(/navigate\(\{\s*to: "\/ticket\/\$id"/);
    expect(shellSrc).toMatch(/navigate\(\{\s*to: "\/worker\/\$id"/);
    expect(shellSrc).toMatch(/cursor:/);
  });

  it("disables the chevrons at the list ends (atStart/atEnd or null neighbour)", () => {
    expect(shellSrc).toMatch(/disabled=\{pager\.atStart \|\| pager\.prevId === null\}/);
    expect(shellSrc).toMatch(/disabled=\{pager\.atEnd \|\| pager\.nextId === null\}/);
  });
});

// ── Gherkin: cold-link renders immediately, pager lights up from the atom ───
describe("Shell.tsx — cold-link ghost lights up silently on rehydrate", () => {
  it("mirrors the resolved ids into listContextAtom so a stream rehydrate re-lights the pager", () => {
    expect(shellSrc).toMatch(/listContextAtom/);
    expect(shellSrc).toMatch(/setListContext\(/);
  });

  it("the entity renders immediately (body + title) regardless of list resolution", () => {
    // LiveDotTitle + DetailBody children render off the entity props, not the list.
    expect(shellSrc).toMatch(/<LiveDotTitle\b/);
  });
});

// ── Gherkin: live-dot reserves cyan for genuine liveness only ───────────────
describe("Shell.tsx — live-dot title reserves cyan for liveness only", () => {
  it("derives the dot via resolveLiveDot (cyan iff working && active)", () => {
    expect(shellSrc).toMatch(/resolveLiveDot/);
  });

  it("the breathing-ring keyframe is the SAME cyan rgba(91,224,255,...) as the board", () => {
    expect(shellSrc).toMatch(/rgba\(91,224,255/);
  });

  it("no chrome element uses the cyan token except the live dot — accents are blue", () => {
    // CTL-1033: the detail-chrome colour consts now ALIAS the canonical board-tokens
    // (LIVE_CYAN → LIVE, CHROME_BLUE → C.blue) instead of carrying their own hexes.
    expect(chromeSrc).toMatch(/LIVE_CYAN = LIVE/);
    expect(chromeSrc).toMatch(/CHROME_BLUE = C\.blue/);
    // the stale cyan token literal must not appear as a static chrome colour in Shell —
    // liveness only reaches the DOM through resolveLiveDot's returned `color`.
    expect(shellSrc).not.toMatch(/#5be0ff/);
    // reduced-motion collapses the breathing animation (ethos-compliant).
    expect(shellSrc).toMatch(/prefers-reduced-motion/);
  });
});

// ── Gherkin: keyboard hook is extended, not forked ──────────────────────────
describe("use-keyboard-nav.ts — extended in place, pre-existing bindings kept", () => {
  it("still binds the pre-existing onEscape / onSlash / onQuestionMark callbacks", () => {
    expect(keyboardHookSrc).toMatch(/onEscape\?:/);
    expect(keyboardHookSrc).toMatch(/onSlash\?:/);
    expect(keyboardHookSrc).toMatch(/onQuestionMark\?:/);
    // and the `/`-focus-search still preventDefaults (kept verbatim).
    expect(keyboardHookSrc).toMatch(/case "focus-search":\s*\n\s*e\.preventDefault\(\)/);
  });

  it("ADDS the new j/k / palette / g-chord callbacks (not a fork)", () => {
    expect(keyboardHookSrc).toMatch(/onNext\?:/);
    expect(keyboardHookSrc).toMatch(/onPrev\?:/);
    expect(keyboardHookSrc).toMatch(/onPalette\?:/);
    expect(keyboardHookSrc).toMatch(/onGoto(Ticket|Worker|Active)\?:/);
  });

  it("classifies through the pure key-nav keymap (so the input guard + ⌘K-pierce are unit-tested)", () => {
    expect(keyboardHookSrc).toMatch(/from "\.\/key-nav"/);
    expect(keyboardHookSrc).toMatch(/classifyKey/);
  });

  it("the shell wires j/k to the pager walk and Esc back to the originating list", () => {
    expect(shellSrc).toMatch(/onNext: goNext/);
    expect(shellSrc).toMatch(/onPrev: goPrev/);
    // onEscape is wired as a shorthand property (the callback is defined above as `onEscape`)
    // and calls goRoot() when no overlay is open.
    expect(shellSrc).toMatch(/onEscape[,\s]/);
    expect(shellSrc).toMatch(/goRoot\(\)/);
  });
});

// ── Gherkin: Properties never fabricates a value ────────────────────────────
describe("Properties — dims unplumbed rows, never fabricates", () => {
  // CTL-1003 §B1: the ticket Properties moved into the floating rail card; the
  // worker page keeps the flat Shell PropertiesRail. Priority/Estimate/Project
  // rows are REMOVED from the ticket Properties card (priority+estimate live on
  // the title row; Project gets its own card).
  it("the ticket Properties card renders Status/Phase/Repo/Team/Updated/PR", () => {
    for (const label of ["Status", "Phase", "Repo", "Team", "Updated", "PR"]) {
      expect(ticketRailSrc).toContain(`label: "${label}"`);
    }
  });

  it("the ticket Properties card no longer carries Priority/Estimate/Project/Scope rows", () => {
    // priority + estimate live on the title row; project is its own card.
    expect(ticketRailSrc).not.toContain(`label: "Priority"`);
    expect(ticketRailSrc).not.toContain(`label: "Estimate"`);
    expect(ticketRailSrc).not.toContain(`label: "Project"`);
    expect(ticketRailSrc).not.toContain(`label: "Scope"`);
  });

  it("labels the model row honestly as the CURRENT phase's signal only", () => {
    expect(ticketRailSrc).toMatch(/Model \(current phase\)/);
  });

  it("the WORKER rail still uses the flat Shell PropertiesRail rows", () => {
    for (const label of ["Status", "Phase", "Repo", "Team", "Runtime", "Cost"]) {
      expect(detailRouteSrc).toContain(`label: "${label}"`);
    }
  });

  it("an unplumbed (undefined) Shell row renders dimmed, never with an invented value", () => {
    // undefined → dimmed; the rendered value falls to an em-dash, never fabricated.
    expect(shellSrc).toMatch(/const unplumbed = r\.value === undefined/);
    expect(shellSrc).toMatch(/data-unplumbed=\{unplumbed\}/);
    expect(shellSrc).toMatch(/r\.value == null \? "—"/);
  });
});

// ── CTL-1003 §B1: the ticket route uses the floating rail-card column ─────────
describe("ticket route renders the floating rail cards, worker keeps the flat rail (CTL-1003)", () => {
  it("the ticket route passes a `rail` (TicketRailCards), not `properties`/`railExtra`", () => {
    const ticketBlock = detailRouteSrc.slice(
      detailRouteSrc.indexOf("export function TicketDetailRoute"),
      detailRouteSrc.indexOf("export function WorkerDetailRoute"),
    );
    expect(ticketBlock).toMatch(/rail=\{/);
    expect(ticketBlock).toContain("TicketRailCards");
  });

  it("the worker route keeps `properties` + `railExtra` (flat rail untouched)", () => {
    const workerBlock = detailRouteSrc.slice(
      detailRouteSrc.indexOf("export function WorkerDetailRoute"),
    );
    expect(workerBlock).toMatch(/properties=\{workerRows/);
    expect(workerBlock).toMatch(/railExtra=\{/);
  });

  it("Shell renders the page-supplied `rail` in place of PropertiesRail when set", () => {
    expect(shellSrc).toMatch(/rail != null \? rail : <PropertiesRail/);
  });
});

// ── CTL-1003 §A1: chrome="bare" suppresses the second header + LiveDotTitle ──
describe("Shell.tsx — chrome='bare' drops the in-page header + live-dot title (CTL-1003)", () => {
  it("gates the in-page <header data-shell-header> on chrome === 'full'", () => {
    // The second header bar renders ONLY in full chrome; bare mode portals the
    // chevrons into the app header instead.
    expect(shellSrc).toMatch(/chrome === "full" \? \(/);
    expect(shellSrc).toContain("data-shell-header");
    expect(shellSrc).toContain("HeaderActions");
    expect(shellSrc).toContain("PagerChevrons");
  });

  it("renders LiveDotTitle only in full chrome (bare drops the floating mono key + dot)", () => {
    expect(shellSrc).toMatch(/chrome === "full" && <LiveDotTitle/);
  });

  it("the ticket route opts into bare chrome; the worker route stays full (default)", () => {
    // The ticket route passes chrome="bare"; the worker route never sets chrome
    // (defaults to "full"), so the worker page keeps its in-page header + LiveDotTitle.
    const ticketBlock = detailRouteSrc.slice(
      detailRouteSrc.indexOf("export function TicketDetailRoute"),
      detailRouteSrc.indexOf("export function WorkerDetailRoute"),
    );
    const workerBlock = detailRouteSrc.slice(
      detailRouteSrc.indexOf("export function WorkerDetailRoute"),
    );
    expect(ticketBlock).toMatch(/chrome="bare"/);
    expect(workerBlock).not.toMatch(/chrome=/);
  });

  it("the PagerChevrons tooltips advertise the K (prev) / J (next) hotkeys (D1)", () => {
    expect(shellSrc).toContain("Previous ticket — K");
    expect(shellSrc).toContain("Next ticket — J");
  });
});

// ── footer stream-health never claims "live" without a real frame ───────────
describe("Shell.tsx — footer stream-health is honest", () => {
  it("only claims 'live' when a frame actually arrived (never fabricated)", () => {
    expect(shellSrc).toMatch(/data-shell-stream-health/);
    // unknown state renders a dim 'stream —', not a fake 'live'.
    expect(shellSrc).toMatch(/"stream —"/);
    expect(detailRouteSrc).toMatch(/lastFrameAt != null/);
  });
});
