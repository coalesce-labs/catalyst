// dead-modules.test.mjs — CTL-1552. Guard against re-introducing modules that
// were deleted as dead code. record-worker-transition.mjs was a CTL-764 Phase 3
// artifact imported ONLY by its own tests — the live worker-transition path is
// the inline `recordTransition` chokepoint in scheduler.mjs. If it comes back
// (e.g. a stale branch resurrects it), this test fails loudly so it can't
// quietly become a second source of truth.
//
// worker-disposition.mjs was ALSO deleted by this ticket's original Phase 5,
// on the same "imported only by its own tests" premise — but CTL-1605
// (#2872, landed after Phase 5 was authored) gave it a real production
// consumer (DISPOSITIONS, for worker-status label precedence) in both
// label-guard.mjs and scheduler.mjs. It is no longer dead code, so it is
// deliberately excluded from this guard and was restored during the CTL-1552
// rebase onto current main.
//
// Run: cd plugins/dev/scripts/execution-core && bun test dead-modules.test.mjs
import { describe, test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

describe("CTL-1552 — deleted dead modules stay deleted", () => {
  for (const name of ["record-worker-transition.mjs"]) {
    test(`${name} is absent (re-introduction is a regression)`, () => {
      expect(existsSync(join(HERE, name))).toBe(false);
      expect(existsSync(join(HERE, name.replace(/\.mjs$/, ".test.mjs")))).toBe(false);
    });
  }
});
