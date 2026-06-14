import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const toggle = readFileSync(join(SRC, "components/ui/toggle.tsx"), "utf8");
const css = readFileSync(join(SRC, "app.css"), "utf8");
const dos = readFileSync(join(SRC, "board/display-options-sections.tsx"), "utf8");

function selectorBlock(selector: string): string {
  const re = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{`);
  const m = re.exec(css);
  if (!m) throw new Error(`selector ${selector} not found`);
  const open = css.indexOf("{", m.index);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return css.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced block for ${selector}`);
}

describe("CTL-1148 Tailwind CVA selected-chip fill is theme-aware", () => {
  it("toggle.tsx no longer hardcodes bg-accent / text-accent-foreground for data-[state=on]", () => {
    expect(toggle).not.toContain("data-[state=on]:bg-accent");
    expect(toggle).not.toContain("data-[state=on]:text-accent-foreground");
  });

  it("toggle.tsx routes the selected state through the --toggle-selected-* token", () => {
    expect(toggle).toContain("data-[state=on]:bg-[var(--toggle-selected-bg)]");
    expect(toggle).toContain("data-[state=on]:text-[var(--toggle-selected-fg)]");
  });

  it(":root (light) defines a surface-tinted selected fill, not the accent", () => {
    const root = selectorBlock(":root");
    expect(root).toMatch(/--toggle-selected-bg:\s*var\(--surface-3\)\s*;/);
    expect(root).toMatch(/--toggle-selected-fg:\s*var\(--fg\)\s*;/);
  });

  it(".dark preserves the accent fill (warm-dark + slate-dark byte-identical)", () => {
    const dark = selectorBlock(".dark");
    expect(dark).toMatch(/--toggle-selected-bg:\s*var\(--accent\)\s*;/);
    expect(dark).toMatch(/--toggle-selected-fg:\s*var\(--accent-foreground\)\s*;/);
  });
});

describe("CTL-1148 inline-style board toggles bridge to theme CSS vars", () => {
  it("ChipToggle/LayoutSwitch selected backgrounds use var(--surface-3), not C.s3", () => {
    expect(dos).toContain("var(--surface-3)");
    expect(dos).not.toMatch(/background:\s*selected\s*\?\s*C\.s3/);
    expect(dos).not.toMatch(/background:\s*pressed\s*\?\s*C\.s3/);
  });

  it("LayoutSwitch container background uses var(--surface-1), not C.s1", () => {
    expect(dos).not.toMatch(/background:\s*C\.s1/);
    expect(dos).toContain("var(--surface-1)");
  });

  it("selected text/border bridge to theme vars (var(--fg)/--fg-muted/--border-strong)", () => {
    expect(dos).toContain("var(--fg)");
    expect(dos).toContain("var(--fg-muted)");
    expect(dos).toContain("var(--border-strong)");
  });
});
