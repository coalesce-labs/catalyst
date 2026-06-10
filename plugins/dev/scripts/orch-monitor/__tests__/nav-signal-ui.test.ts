// nav-signal-ui.test.ts — CTL-896 / SHELL6 UI-contract guards. `bun test` has no
// DOM, so — matching app-shell-ia.test.ts (CTL-893) — the pure UI contract
// (lib/nav-signal.ts: the decode guard + the daemon color/label mapping) is unit-
// tested directly, and the rail-wiring scenario (mocks replaced by the live
// nav-signal projection) is asserted by static source analysis of app-sidebar.tsx.
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  isNavSignal,
  decodeNavSignalFrame,
  daemonDotClass,
  daemonLabel,
  type NavSignal,
} from "../ui/src/lib/nav-signal";

const HERE = dirname(fileURLToPath(import.meta.url));
const UI_SRC = join(HERE, "..", "ui", "src");
const read = (rel: string) => readFileSync(join(UI_SRC, rel), "utf8");

const sidebarSrc = read("components/app-sidebar.tsx");
// CTL-930: health dots moved from sidebar footer to app-footer.tsx.
const footerSrc = read("components/app-footer.tsx");

/** Strip JS/JSX comments so token assertions can't be tripped by prose. */
function stripComments(src: string): string {
  return src
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}
const sidebarCode = stripComments(sidebarSrc);
const footerCode = stripComments(footerSrc);

const signal = (overrides: Partial<NavSignal> = {}): NavSignal => ({
  workerCount: 0,
  queueDepth: 0,
  anomaly: false,
  daemon: "healthy",
  generatedAt: "2026-06-08T00:00:00.000Z",
  ...overrides,
});

describe("nav-signal UI contract (CTL-896 / SHELL6)", () => {
  describe("isNavSignal / decodeNavSignalFrame", () => {
    it("accepts a well-formed signal", () => {
      expect(isNavSignal(signal())).toBe(true);
    });

    it("rejects a frame missing fields or with a bad daemon value", () => {
      expect(isNavSignal({ workerCount: 1 })).toBe(false);
      expect(isNavSignal({ ...signal(), daemon: "green" })).toBe(false);
      expect(isNavSignal(null)).toBe(false);
    });

    it("decodes a JSON frame, returning null on garbage (not a throw)", () => {
      expect(decodeNavSignalFrame(JSON.stringify(signal({ workerCount: 4 })))?.workerCount).toBe(4);
      expect(decodeNavSignalFrame("{ not json")).toBeNull();
      expect(decodeNavSignalFrame(JSON.stringify({ daemon: "x" }))).toBeNull();
    });
  });

  describe("daemon color discipline (emerald/amber/red — cyan is reserved)", () => {
    it("maps healthy → emerald, degraded → amber, offline → red", () => {
      expect(daemonDotClass("healthy")).toBe("bg-emerald-500");
      expect(daemonDotClass("degraded")).toBe("bg-amber-500");
      expect(daemonDotClass("offline")).toBe("bg-red-500");
    });

    it("never uses the reserved cyan live-signal color for any daemon state", () => {
      for (const d of ["healthy", "degraded", "offline"] as const) {
        expect(daemonDotClass(d)).not.toContain("5be0ff");
        expect(daemonDotClass(d)).not.toContain("cyan");
      }
    });

    it("labels each daemon state", () => {
      expect(daemonLabel("healthy")).toBe("Daemon healthy");
      expect(daemonLabel("degraded")).toBe("Daemon degraded");
      expect(daemonLabel("offline")).toBe("Daemon offline");
    });
  });

  describe("app-sidebar wiring (static source analysis)", () => {
    it("consumes the live nav signal hook (no more mock badges)", () => {
      expect(sidebarCode).toContain("useNavSignal");
      expect(sidebarCode).toContain("const nav = useNavSignal()");
    });

    it("no longer hardcodes the mock badge numbers 4 / 7", () => {
      // The OPERATE IA must not carry literal `badge: 4` / `badge: 7` mocks.
      expect(sidebarCode).not.toMatch(/badge:\s*4\b/);
      expect(sidebarCode).not.toMatch(/badge:\s*7\b/);
    });

    it("derives the Workers count + Queue depth badges from the signal", () => {
      expect(sidebarCode).toContain("nav.workerCount");
      expect(sidebarCode).toContain("nav.queueDepth");
    });

    it("derives the Board anomaly dot from the signal", () => {
      expect(sidebarCode).toContain("nav.anomaly");
    });

    it("wires the footer daemon-health dot to the signal (no hardcoded emerald)", () => {
      // CTL-930: health dots moved from app-sidebar.tsx to app-footer.tsx.
      // The daemon dot lives in AppFooter; sidebar no longer needs daemonDotClass.
      expect(footerCode).toContain("daemonDotClass(nav.daemon)");
      // The old SHELL1 footer hardcoded `bg-emerald-500` for the daemon dot;
      // SHELL6 must drive it off daemonDotClass, not a literal class.
      expect(footerCode).not.toMatch(/rounded-full bg-emerald-500/);
    });
  });
});
