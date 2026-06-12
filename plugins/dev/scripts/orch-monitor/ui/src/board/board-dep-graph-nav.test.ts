import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const boardSrc = readFileSync(join(import.meta.dir, "Board.tsx"), "utf8");
const routerSrc = readFileSync(join(import.meta.dir, "..", "app-router.tsx"), "utf8");

describe("CTL-1083 — Dep Graph button navigates to the registered route", () => {
  it("the Dep Graph button calls navigate to /dep-graph", () => {
    expect(boardSrc).toMatch(/navigate\(\{\s*to:\s*"\/dep-graph"/);
  });
  it("the /dep-graph route is registered in the router", () => {
    expect(routerSrc).toMatch(/path:\s*"\/dep-graph"/);
  });
});
