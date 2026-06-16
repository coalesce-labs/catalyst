// icon-picker-model.test.ts — unit tests for buildIconPickerRows and resolveIconSectionState (CTL-997 Phase 4 / CTL-1207).
// Pure view-model builder — no DOM, no React.
import { describe, it, expect } from "bun:test";
import { buildIconPickerRows, resolveIconSectionState } from "./icon-picker-model";
import type { RepoIconMap } from "@/hooks/use-repo-icons";

describe("buildIconPickerRows", () => {
  it("builds one row per repo with an Auto option plus each candidate, marking Auto active when no pick", () => {
    const map: RepoIconMap = {
      catalyst: {
        autoDataUrl: "data:svg", selectedPath: "logo.svg", override: null,
        candidates: [
          { path: "logo.svg", format: "svg", downloadUrl: "u1", dataUrl: "data:svg" },
          { path: "favicon.ico", format: "ico", downloadUrl: "u2", dataUrl: "data:ico" },
        ],
      },
    };
    const rows = buildIconPickerRows(["catalyst"], map, {});
    expect(rows).toHaveLength(1);
    expect(rows[0].repo).toBe("catalyst");
    // null = Auto option
    expect(rows[0].options.map((o) => o.path)).toEqual([null, "logo.svg", "favicon.ico"]);
    // no pick → Auto is active
    expect(rows[0].options.find((o) => o.path === null)?.active).toBe(true);
    expect(rows[0].options.find((o) => o.path === "logo.svg")?.active).toBe(false);
  });

  it("marks the picked candidate active instead of Auto", () => {
    const map: RepoIconMap = {
      catalyst: {
        autoDataUrl: "data:ico", selectedPath: "favicon.ico", override: null,
        candidates: [
          { path: "logo.svg", format: "svg", downloadUrl: "u1", dataUrl: "data:svg" },
          { path: "favicon.ico", format: "ico", downloadUrl: "u2", dataUrl: "data:ico" },
        ],
      },
    };
    const rows = buildIconPickerRows(["catalyst"], map, { catalyst: "favicon.ico" });
    const opts = rows[0].options;
    expect(opts.find((o) => o.path === null)?.active).toBe(false);
    expect(opts.find((o) => o.path === "favicon.ico")?.active).toBe(true);
    expect(opts.find((o) => o.path === "logo.svg")?.active).toBe(false);
  });

  it("omits repos with no candidates", () => {
    const map: RepoIconMap = {
      adva: { autoDataUrl: null, selectedPath: null, override: null, candidates: [] },
    };
    const rows = buildIconPickerRows(["adva"], map, {});
    expect(rows).toHaveLength(0);
  });

  it("returns empty rows when repos list is empty", () => {
    expect(buildIconPickerRows([], {}, {})).toHaveLength(0);
  });

  it("includes a label and dataUrl on the Auto option", () => {
    const map: RepoIconMap = {
      r: {
        autoDataUrl: "data:svg", selectedPath: "logo.svg", override: null,
        candidates: [{ path: "logo.svg", format: "svg", downloadUrl: "u", dataUrl: "data:svg" }],
      },
    };
    const autoOpt = buildIconPickerRows(["r"], map, {})[0].options[0];
    expect(autoOpt.path).toBeNull();
    expect(autoOpt.label).toBeDefined();
    expect(autoOpt.dataUrl).toBe("data:svg"); // Auto shows the resolved best
  });

  it("uses format.toUpperCase() as the label for candidate options", () => {
    const map: RepoIconMap = {
      r: {
        autoDataUrl: "data:svg", selectedPath: "logo.svg", override: null,
        candidates: [
          { path: "logo.svg", format: "svg", downloadUrl: "u1", dataUrl: "data:svg" },
          { path: "favicon.ico", format: "ico", downloadUrl: "u2", dataUrl: null },
          { path: "logo.png", format: "png", downloadUrl: "u3", dataUrl: "data:png" },
        ],
      },
    };
    const opts = buildIconPickerRows(["r"], map, {})[0].options;
    expect(opts.find((o) => o.path === "logo.svg")?.label).toBe("SVG");
    expect(opts.find((o) => o.path === "favicon.ico")?.label).toBe("ICO");
    expect(opts.find((o) => o.path === "logo.png")?.label).toBe("PNG");
  });
});

describe("resolveIconSectionState", () => {
  it("is 'loading' before the board snapshot arrives (no payload, no rows)", () => {
    expect(resolveIconSectionState(false, 0)).toBe("loading");
  });
  it("is 'empty' once loaded with no icon rows", () => {
    expect(resolveIconSectionState(true, 0)).toBe("empty");
  });
  it("is 'ready' once loaded with rows", () => {
    expect(resolveIconSectionState(true, 3)).toBe("ready");
  });
  it("is 'ready' when rows present even if payload not loaded (warm paint)", () => {
    expect(resolveIconSectionState(false, 3)).toBe("ready");
  });
});
