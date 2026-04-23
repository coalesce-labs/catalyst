import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer } from "../server";
// Pure helpers exported via CommonJS guard at the bottom of chrome.js.
// Static import path keeps `security/detect-non-literal-require` happy and
// exercises the actual artifact that ships to the browser.
import * as chrome from "../public/mockups/_shared/chrome.js";

const chromePath = join(
  import.meta.dir,
  "..",
  "public",
  "mockups",
  "_shared",
  "chrome.js",
);

describe("chrome.js pure helpers — SYSTEMS/THEMES/GNAV constants", () => {
  it("exposes SYSTEMS with both design systems", () => {
    expect(chrome.SYSTEMS).toEqual(["operator-console", "precision-instrument"]);
  });

  it("exposes THEMES with dark and light", () => {
    expect(chrome.THEMES).toEqual(["dark", "light"]);
  });

  it("exposes the full g-prefix nav table per CTL-145", () => {
    expect(chrome.GNAV).toEqual({
      h: "index.html",
      d: "orch.html",
      w: "worker.html",
      c: "comms.html",
      b: "briefing.html",
      v: "agent-graph.html",
      t: "todos.html",
      r: "brand.html",
    });
  });
});

describe("chrome.js pure helpers — nextSystem / nextTheme", () => {
  it("nextSystem cycles forward and wraps", () => {
    expect(chrome.nextSystem("operator-console")).toBe("precision-instrument");
    expect(chrome.nextSystem("precision-instrument")).toBe("operator-console");
  });

  it("nextSystem falls back to first system for unknown input", () => {
    expect(chrome.nextSystem("unknown-system")).toBe("operator-console");
  });

  it("nextTheme flips dark and light", () => {
    expect(chrome.nextTheme("dark")).toBe("light");
    expect(chrome.nextTheme("light")).toBe("dark");
  });

  it("nextTheme defaults unknown values back to dark", () => {
    expect(chrome.nextTheme("magenta")).toBe("dark");
  });
});

describe("chrome.js pure helpers — isTypingTarget", () => {
  it("returns true for INPUT element", () => {
    expect(chrome.isTypingTarget({ tagName: "INPUT" })).toBe(true);
  });

  it("returns true for TEXTAREA element", () => {
    expect(chrome.isTypingTarget({ tagName: "TEXTAREA" })).toBe(true);
  });

  it("returns true for SELECT element", () => {
    expect(chrome.isTypingTarget({ tagName: "SELECT" })).toBe(true);
  });

  it("returns true for contenteditable element", () => {
    expect(chrome.isTypingTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
  });

  it("returns false for plain div", () => {
    expect(chrome.isTypingTarget({ tagName: "DIV" })).toBe(false);
  });

  it("returns false for null/undefined target", () => {
    expect(chrome.isTypingTarget(null)).toBe(false);
    expect(chrome.isTypingTarget(undefined)).toBe(false);
  });
});

describe("chrome.js pure helpers — shouldIgnoreKey", () => {
  it("returns true when event target is a typing element", () => {
    expect(chrome.shouldIgnoreKey({ key: "g", target: { tagName: "INPUT" } })).toBe(true);
  });

  it("returns false for non-typing targets", () => {
    expect(chrome.shouldIgnoreKey({ key: "g", target: { tagName: "DIV" } })).toBe(false);
  });

  it("returns false when target is missing", () => {
    expect(chrome.shouldIgnoreKey({ key: "g" })).toBe(false);
  });
});

describe("chrome.js pure helpers — resolveGNav", () => {
  it("resolves known g-prefix keys", () => {
    expect(chrome.resolveGNav("h")).toBe("index.html");
    expect(chrome.resolveGNav("r")).toBe("brand.html");
    expect(chrome.resolveGNav("d")).toBe("orch.html");
  });

  it("returns undefined for unknown keys", () => {
    expect(chrome.resolveGNav("x")).toBeUndefined();
    expect(chrome.resolveGNav("")).toBeUndefined();
  });
});

describe("chrome.js file structure — static markers", () => {
  it("contains keybinding-related symbols", async () => {
    const text = await Bun.file(chromePath).text();
    // Sanity anchors — these strings should survive any future refactor that still
    // implements CTL-145.
    expect(text).toContain("data-theme");
    expect(text).toContain("mockup-cheatsheet");
    expect(text).toContain("GNAV");
    expect(text).toContain("keydown");
  });

  it("contains CTL-166 nav-shell symbols", async () => {
    const text = await Bun.file(chromePath).text();
    expect(text).toContain("mockup-palette");
    expect(text).toContain("mockup-topbar__crumb");
    expect(text).toContain("mockup-topbar__chip");
    expect(text).toContain("mockup-breadcrumb");
    expect(text).toContain("metaKey");
  });
});

describe("chrome.css file — cheatsheet styles exist", () => {
  it("defines .mockup-cheatsheet styles", async () => {
    const cssPath = join(
      import.meta.dir,
      "..",
      "public",
      "mockups",
      "_shared",
      "chrome.css",
    );
    const text = await Bun.file(cssPath).text();
    expect(text).toContain(".mockup-cheatsheet");
  });

  it("defines CTL-166 nav-shell styles", async () => {
    const cssPath = join(
      import.meta.dir,
      "..",
      "public",
      "mockups",
      "_shared",
      "chrome.css",
    );
    const text = await Bun.file(cssPath).text();
    expect(text).toContain(".mockup-palette");
    expect(text).toContain(".mockup-topbar__crumb");
    expect(text).toContain(".mockup-topbar__chip");
  });
});

describe("chrome.js pure helpers — parseBreadcrumb", () => {
  it("returns empty array for missing/blank input", () => {
    expect(chrome.parseBreadcrumb("")).toEqual([]);
    expect(chrome.parseBreadcrumb("   ")).toEqual([]);
    expect(chrome.parseBreadcrumb(null)).toEqual([]);
    expect(chrome.parseBreadcrumb(undefined)).toEqual([]);
  });

  it("returns single segment", () => {
    expect(chrome.parseBreadcrumb("Home")).toEqual(["Home"]);
  });

  it("splits on slash with surrounding spaces", () => {
    expect(chrome.parseBreadcrumb("Monitor / ctl-ux-apr20")).toEqual([
      "Monitor",
      "ctl-ux-apr20",
    ]);
  });

  it("handles many segments", () => {
    expect(
      chrome.parseBreadcrumb("Monitor / orch-2026-04-22-3 / wave 2 / CTL-138"),
    ).toEqual(["Monitor", "orch-2026-04-22-3", "wave 2", "CTL-138"]);
  });

  it("trims extra whitespace and drops empty segments", () => {
    expect(chrome.parseBreadcrumb("  A  /  B  / / C  ")).toEqual(["A", "B", "C"]);
  });
});

describe("chrome.js pure helpers — isMacPlatform", () => {
  it("detects platform=MacIntel", () => {
    expect(chrome.isMacPlatform({ platform: "MacIntel" })).toBe(true);
  });

  it("detects platform containing Mac in any case", () => {
    expect(chrome.isMacPlatform({ platform: "macOS" })).toBe(true);
  });

  it("returns false for Windows", () => {
    expect(chrome.isMacPlatform({ platform: "Win32" })).toBe(false);
  });

  it("returns false for Linux", () => {
    expect(chrome.isMacPlatform({ platform: "Linux x86_64" })).toBe(false);
  });

  it("falls back to userAgent when platform is missing", () => {
    expect(
      chrome.isMacPlatform({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5)" }),
    ).toBe(true);
    expect(
      chrome.isMacPlatform({ userAgent: "Mozilla/5.0 (X11; Linux x86_64)" }),
    ).toBe(false);
  });

  it("returns false for empty navigator object", () => {
    expect(chrome.isMacPlatform({})).toBe(false);
    expect(chrome.isMacPlatform(null)).toBe(false);
    expect(chrome.isMacPlatform(undefined)).toBe(false);
  });
});

describe("chrome.js pure helpers — paletteActions", () => {
  it("returns 12 actions (8 nav + 3 appearance + 1 help)", () => {
    const actions = chrome.paletteActions(chrome.GNAV);
    expect(actions.length).toBe(12);
  });

  it("covers every GNAV key with a nav action", () => {
    const actions = chrome.paletteActions(chrome.GNAV);
    const navPaths = actions.filter((a) => a.type === "nav").map((a) => a.payload.path);
    expect(navPaths.sort()).toEqual(Object.values(chrome.GNAV).sort());
  });

  it("includes all three groups", () => {
    const actions = chrome.paletteActions(chrome.GNAV);
    const groups = new Set(actions.map((a) => a.group));
    expect(groups.has("Navigate")).toBe(true);
    expect(groups.has("Appearance")).toBe(true);
    expect(groups.has("Help")).toBe(true);
  });

  it("labels Orchestrator nav action", () => {
    const actions = chrome.paletteActions(chrome.GNAV);
    const orch = actions.find((a) => a.type === "nav" && a.payload.path === "orch.html");
    expect(orch).toBeDefined();
    expect(orch?.label).toBe("Orchestrator");
  });

  it("includes appearance actions for theme/system/palette", () => {
    const actions = chrome.paletteActions(chrome.GNAV);
    const appearanceLabels = actions
      .filter((a) => a.type === "appearance")
      .map((a) => a.label)
      .sort();
    expect(appearanceLabels).toEqual(
      ["Cycle palette", "Cycle system", "Toggle theme"].sort(),
    );
  });

  it("includes a help action for the cheatsheet", () => {
    const actions = chrome.paletteActions(chrome.GNAV);
    const help = actions.find((a) => a.type === "help");
    expect(help).toBeDefined();
    expect(help?.label.toLowerCase()).toContain("cheat");
  });
});

describe("chrome.js pure helpers — filterPaletteActions", () => {
  const actions: chrome.PaletteAction[] = [
    { id: "n-h", group: "Navigate", label: "Home", type: "nav", payload: {} },
    { id: "n-d", group: "Navigate", label: "Orchestrator", type: "nav", payload: {} },
    { id: "n-w", group: "Navigate", label: "Worker", type: "nav", payload: {} },
    { id: "a-t", group: "Appearance", label: "Toggle theme", type: "appearance", payload: {} },
    { id: "h-c", group: "Help", label: "Open cheatsheet", type: "help", payload: {} },
  ];

  it("returns all actions for empty / whitespace query", () => {
    expect(chrome.filterPaletteActions(actions, "").length).toBe(actions.length);
    expect(chrome.filterPaletteActions(actions, "   ").length).toBe(actions.length);
  });

  it("does case-insensitive substring match on label", () => {
    expect(chrome.filterPaletteActions(actions, "orch").map((a) => a.id)).toEqual(["n-d"]);
    expect(chrome.filterPaletteActions(actions, "ORCH").map((a) => a.id)).toEqual(["n-d"]);
  });

  it("returns empty array when nothing matches", () => {
    expect(chrome.filterPaletteActions(actions, "zzzz")).toEqual([]);
  });

  it("matches across groups", () => {
    expect(chrome.filterPaletteActions(actions, "o").map((a) => a.id).sort()).toEqual(
      ["a-t", "h-c", "n-d", "n-h", "n-w"].sort(),
    );
  });
});

describe("server serves the mockup chrome assets", () => {
  let server: ReturnType<typeof createServer>;
  let baseUrl: string;
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mockup-chrome-test-"));
    const wtDir = join(tmpDir, "wt");
    mkdirSync(wtDir, { recursive: true });
    mkdirSync(join(wtDir, "orch-test", "workers"), { recursive: true });
    server = createServer({
      port: 0,
      wtDir,
      startWatcher: false,
      annotationsDbPath: join(tmpDir, "annotations.db"),
    });
    baseUrl = `http://localhost:${server.port}`;
  });

  afterAll(() => {
    void server?.stop(true);
    if (tmpDir) {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it("serves chrome.js with JS content-type", async () => {
    const res = await fetch(`${baseUrl}/mockups/_shared/chrome.js`);
    expect(res.status).toBe(200);
    const ct = res.headers.get("content-type") || "";
    expect(ct.toLowerCase()).toContain("javascript");
  });

  it("serves chrome.css with CSS content-type", async () => {
    const res = await fetch(`${baseUrl}/mockups/_shared/chrome.css`);
    expect(res.status).toBe(200);
    const ct = res.headers.get("content-type") || "";
    expect(ct.toLowerCase()).toContain("css");
  });

  it("serves the mockup index HTML with pre-paint theme bootstrap", async () => {
    const res = await fetch(`${baseUrl}/mockups/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    // Pre-paint bootstrap must set data-theme before first paint to avoid theme flicker.
    expect(html).toContain("data-theme");
  });
});
