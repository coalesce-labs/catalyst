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

  it("no chrome element uses the cyan token except the live dot — accents are blue #4ea1ff", () => {
    expect(chromeSrc).toMatch(/LIVE_CYAN = "#5be0ff"/);
    expect(chromeSrc).toMatch(/CHROME_BLUE = "#4ea1ff"/);
    // the cyan token literal must not appear as a static chrome colour in Shell —
    // it only reaches the DOM through resolveLiveDot's returned `color`.
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

// ── Gherkin: Properties rail never fabricates a value ───────────────────────
describe("Shell.tsx — Properties rail dims unplumbed rows, never fabricates", () => {
  // CTL-996: the T-shirt "Scope" row was REMOVED from the ticket rail (one
  // complexity measure — the Fibonacci estimate — on this reading surface).
  it("renders the shared cheap rows (Status/Phase/Priority/Estimate/Project/Repo/Team/Updated/PR)", () => {
    for (const label of ["Status", "Phase", "Priority", "Estimate", "Project", "Repo", "Team", "Updated", "PR"]) {
      expect(detailRouteSrc).toContain(`label: "${label}"`);
    }
  });

  it("no longer renders the T-shirt Scope row on the ticket rail (CTL-996)", () => {
    expect(detailRouteSrc).not.toContain(`label: "Scope"`);
  });

  it("labels the model row honestly as the CURRENT phase's signal only", () => {
    expect(detailRouteSrc).toMatch(/Model \(current phase\)/);
  });

  it("an unplumbed (undefined) row renders dimmed, never with an invented value", () => {
    // undefined → dimmed; the rendered value falls to an em-dash, never fabricated.
    expect(shellSrc).toMatch(/const unplumbed = r\.value === undefined/);
    expect(shellSrc).toMatch(/data-unplumbed=\{unplumbed\}/);
    expect(shellSrc).toMatch(/r\.value == null \? "—"/);
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
