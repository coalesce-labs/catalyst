// doctor-index-serving-root.test.mjs — CTL-1935. Tests for checkIndexServingRoot().
// All deps are injected: the test touches no filesystem, no git, no network. Run:
//   cd plugins/dev/scripts/execution-core && bun test doctor-index-serving-root
//
// The invariant under test is not "does it pass on a good root" — it is that EVERY way of not
// knowing (no pin, no root, unfetched pin, unreadable status) renders as something other than a
// clean result. The measured defect this comes from is a node where a cold index ran 332 commits
// stale and every signal read normal.

import { describe, test, expect } from "bun:test";
import { checkIndexServingRoot } from "../doctor.mjs";

const SHA = "4a84cd463606583ad73a5728871029dfbf9409c6";
const OTHER = "1111111111111111111111111111111111111111";

const PIN = {
  repo: "https://example.invalid/catalyst-cloud.git",
  path: "/srv/index-source",
  sha: SHA,
  probe: { file: "apps/context-engine/src/wiki/llm.ts", symbol: "SKIP_CACHE_HEADER" },
};

// A git stub whose behaviour is described per-subcommand, so each case changes exactly one thing.
function gitStub({ head = SHA, hasPin = true, ancestor = true, dirty = "", statusFails = false } = {}) {
  return (_root, args) => {
    if (args[0] === "rev-parse") return { status: head ? 0 : 1, stdout: head };
    if (args[0] === "cat-file") return { status: hasPin ? 0 : 1, stdout: "" };
    if (args[0] === "merge-base") return { status: ancestor ? 0 : 1, stdout: "" };
    if (args[0] === "status") return { status: statusFails ? 1 : 0, stdout: dirty };
    return { status: 1, stdout: "" };
  };
}

function deps(over = {}) {
  return {
    pinPath: "/pin.json",
    readJson: () => PIN,
    readText: () => 'export const SKIP_CACHE_HEADER = "cf-aig-skip-cache";',
    exists: () => true,
    git: gitStub(),
    env: {},
    ...over,
  };
}

describe("checkIndexServingRoot", () => {
  test("a root at the pin, clean, with the probe symbol present -> pass", () => {
    const c = checkIndexServingRoot(deps());
    expect(c.status).toBe("pass");
    expect(c.detail).toContain("is exactly the pinned");
  });

  // ⛔ The case the ticket is about. Measured on mini-2: 332 commits behind, and the run looked
  // completely normal.
  test("a STALE root (HEAD is not the pin) -> warn, naming it", () => {
    const c = checkIndexServingRoot(deps({ git: gitStub({ head: OTHER, ancestor: false }) }));
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("is not the pinned");
  });

  // ⛔ Codex #3525 P1: the first cut accepted any DESCENDANT of the pin, so a root that had
  // drifted ahead ran post-pin code while this reported it pinned. A pin that only sets a floor
  // is not a pin.
  test("a DESCENDANT of the pin -> warn, named as AHEAD", () => {
    const c = checkIndexServingRoot(deps({ git: gitStub({ head: OTHER, ancestor: true }) }));
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("is AHEAD of pinned");
  });

  // ⭐ Measured on the dev laptop: 18 commits behind the pin FAILED ancestry while the content
  // probe PASSED, because the symbol had merged before that HEAD. Content alone clears this root.
  test("the pinned-head check catches a root whose content probe passes", () => {
    const c = checkIndexServingRoot(deps({ git: gitStub({ head: OTHER, ancestor: false }) }));
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("is not the pinned");
    expect(c.detail).not.toContain("SKIP_CACHE_HEADER is absent");
  });

  // ...and the converse, so neither half is decorative.
  test("content catches a root whose HEAD is exactly the pin", () => {
    const c = checkIndexServingRoot(deps({ readText: () => "export const SOMETHING_ELSE = 1;" }));
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("SKIP_CACHE_HEADER is absent");
  });

  test("a locally modified probe file -> warn, though HEAD and content both pass", () => {
    const c = checkIndexServingRoot(deps({ git: gitStub({ dirty: " M apps/context-engine/src/wiki/llm.ts" }) }));
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("local modifications");
  });

  // ⛔ Codex #3525 P1: cleanliness scoped to the probe file let an edit under apps/index-host —
  // the code the indexer actually RUNS — read as clean.
  test("a modification OUTSIDE the probe file is caught too", () => {
    const c = checkIndexServingRoot(deps({ git: gitStub({ dirty: " M apps/index-host/src/cli.ts" }) }));
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("local modifications");
  });

  // ⛔ Every "I could not look" must render as something other than a pass.
  test("no serving root at all -> warn, not silence", () => {
    const c = checkIndexServingRoot(deps({ exists: () => false }));
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("no index serving root");
  });

  test("the pinned sha has never been fetched -> warn", () => {
    const c = checkIndexServingRoot(deps({ git: gitStub({ hasPin: false }) }));
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("is not present in");
  });

  test("HEAD unreadable -> warn (the pin is UNPROVEN)", () => {
    const c = checkIndexServingRoot(deps({ git: gitStub({ head: "" }) }));
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("UNPROVEN");
  });

  // ⛔ Codex #3525 P1: a failing `git status` yielded an empty string that read as CLEAN.
  test("git status unreadable -> warn saying cleanliness is UNMEASURED, never pass", () => {
    const c = checkIndexServingRoot(deps({ git: gitStub({ statusFails: true }) }));
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("UNMEASURED");
  });

  test("an unreadable pin file -> info naming the reason, never pass", () => {
    const c = checkIndexServingRoot(
      deps({
        readJson: () => {
          throw new Error("ENOENT");
        },
      }),
    );
    expect(c.status).toBe("info");
    expect(c.detail).toContain("ENOENT");
  });

  test("an abbreviated sha is not a pin -> warn", () => {
    const c = checkIndexServingRoot(deps({ readJson: () => ({ ...PIN, sha: SHA.slice(0, 9) }) }));
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("full 40-char hex sha");
  });

  test("a pin with no content probe -> warn (ancestry alone is not enough)", () => {
    const c = checkIndexServingRoot(deps({ readJson: () => ({ ...PIN, probe: undefined }) }));
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("no content probe");
  });

  // ⛔ Doctor's FAIL count gates worker activation, so this check is advisory by contract —
  // exactly like checkWorkerLabels and checkDrainDisabled.
  test("NEVER emits a fail record, in any of the cases above", () => {
    const cases = [
      deps(),
      deps({ git: gitStub({ head: OTHER, ancestor: false }) }),
      deps({ git: gitStub({ head: OTHER, ancestor: true }) }),
      deps({ git: gitStub({ dirty: " M apps/index-host/src/cli.ts" }) }),
      deps({ exists: () => false }),
      deps({ git: gitStub({ hasPin: false }) }),
      deps({ git: gitStub({ head: "" }) }),
      deps({ git: gitStub({ statusFails: true }) }),
      deps({ readText: () => "nope" }),
      deps({ readJson: () => ({ ...PIN, sha: "main" }) }),
      deps({
        readJson: () => {
          throw new Error("boom");
        },
      }),
    ];
    for (const d of cases) expect(checkIndexServingRoot(d).status).not.toBe("fail");
  });

  // ⛔ Positive control for the block above: a fail status IS representable, so "never fail" is a
  // property of this check and not of the assertion being unfalsifiable.
  test("control — the status vocabulary can express fail", () => {
    expect(["pass", "warn", "info", "fail"]).toContain("fail");
    const c = checkIndexServingRoot(deps());
    expect(["pass", "warn", "info", "fail"]).toContain(c.status);
  });
});
