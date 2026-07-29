// dead-modules.test.mjs — CTL-1552. Guard against re-introducing modules that
// were deleted as dead code. worker-disposition.mjs and record-worker-transition.mjs
// were CTL-764 Phase 3 artifacts imported ONLY by their own tests — the live
// worker-transition path is the inline `recordTransition` chokepoint in
// scheduler.mjs. If either file comes back (e.g. a stale branch resurrects it),
// this test fails loudly so it can't quietly become a second source of truth.
//
// Run: cd plugins/dev/scripts/execution-core && bun test dead-modules.test.mjs
import { describe, test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

describe("CTL-1552 — deleted dead modules stay deleted", () => {
  for (const name of ["worker-disposition.mjs", "record-worker-transition.mjs"]) {
    test(`${name} is absent (re-introduction is a regression)`, () => {
      expect(existsSync(join(HERE, name))).toBe(false);
      expect(existsSync(join(HERE, name.replace(/\.mjs$/, ".test.mjs")))).toBe(false);
    });
  }
});
