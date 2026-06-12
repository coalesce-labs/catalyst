import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(import.meta.dir, "Board.tsx"), "utf8");

describe("CTL-1016 — Workers grouping defaults to Pipeline", () => {
  it("initializes workerGrouping to 'phase' (Pipeline), not 'status'", () => {
    expect(src).toContain('useState<WorkerGrouping>("phase")');
    expect(src).not.toContain('useState<WorkerGrouping>("status")');
  });
});
