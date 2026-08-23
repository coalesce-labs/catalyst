// layer1-relocation.test.mjs — CTL-1214 Phase 2. The Layer-1 → node.json
// migration's DECISION TABLE, exercised against the pure planner so every rule
// is testable with no I/O, plus the atomic-write ordering of the applier.
//
// Run: cd plugins/dev/scripts && bun test __tests__/layer1-relocation.test.mjs

import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  planLayer1Migration,
  applyLayer1Migration,
  RELOCATED_PATHS,
} from "../lib/migrate-layer1-config.mjs";
// CTL-1214: the REAL resolver the migration exists to keep answering, imported
// from the zero-import leaf (not scheduler.mjs — same definition, re-exported
// there). The end-to-end assertion below runs through it rather than restating
// its ladder, so a change to the precedence rule fails this suite too.
import { resolveTargetSetpoint } from "../lib/autotune-setpoint.mjs";

let dirs = [];
afterEach(() => {
  for (const d of dirs) {
    try {
      chmodSync(d, 0o755);
    } catch {
      /* best effort */
    }
    rmSync(d, { recursive: true, force: true });
  }
  dirs = [];
});
function mkdir() {
  const d = mkdtempSync(join(tmpdir(), "ctl1214-mig-"));
  dirs.push(d);
  return d;
}

// The full committed shape this repo really carries at a8d4946c.
const FULL_LAYER1 = () => ({
  catalyst: {
    projectKey: "catalyst-workspace",
    project: { ticketPrefix: "CTL" },
    linear: { teamKey: "CTL", teamId: "f317bf00", stateMap: { todo: "Todo", done: "Done" } },
    thoughts: { org: "coalesce-labs", profile: "coalesce-labs", directory: "catalyst-workspace", user: null },
    monitor: {
      github: { repoColors: { "coalesce-labs/catalyst": "green" } },
      linear: { teams: [{ key: "CTL", vcsRepo: "coalesce-labs/catalyst" }] },
    },
    deployment: { mode: "cluster" },
    orchestration: {
      dispatchMode: "phase-agents",
      worktreeRefresh: { enabled: true, intervalSeconds: 300, quietSeconds: 30 },
      reconcile: { mode: "notify", intervalSeconds: 600 },
      executionCore: {
        maxParallel: 4,
        minParallel: 1,
        maxParallelCeiling: 40,
        eligibleQuery: { status: "Todo", team: null, project: null, label: null, priority: null },
      },
    },
    feedback: { autoFile: true, githubRepo: "coalesce-labs/catalyst", labels: ["auto-submitted"] },
    sweep: { idleHours: 48, intervalHours: 1, salvagePush: false, maxRemovalsPerRun: 10 },
  },
});

const movedPaths = (plan) => plan.moves.map((m) => m.path).sort();
const keptPaths = (plan) => plan.kept.map((k) => k.path).sort();

describe("planLayer1Migration — the non-clobber rule (D1)", () => {
  it("does NOT write a key the merged Layer-2 already defines, and names it kept", () => {
    // This host's real state: salvagePush is machine-canonical in Layer-2.
    // node.json outranks the legacy file, so a blind copy of the Layer-1 seed
    // would SHADOW the operator's value.
    const plan = planLayer1Migration({
      layer1: FULL_LAYER1(),
      mergedLayer2: { catalyst: { sweep: { maxRemovalsPerRun: 20 } } },
    });
    expect(movedPaths(plan)).not.toContain("sweep.maxRemovalsPerRun");
    expect(movedPaths(plan)).toContain("sweep.idleHours");
    expect(movedPaths(plan)).toContain("sweep.intervalHours");

    const kept = plan.kept.find((k) => k.path === "sweep.maxRemovalsPerRun");
    expect(kept).toBeDefined();
    expect(kept.existingValue).toBe(20);
  });

  // ── CTL-1214 remediation: the executionCore.maxParallel special case ──────
  //
  // maxParallel is the ONE relocated leaf that must never LAND in node.json (it
  // would permanently shadow writeLayer2MaxParallel's runtime mirror in the
  // legacy Layer-2 file, which node.json outranks) AND whose Layer-1 value must
  // not be dropped (it is the operator's committed setpoint — the value CTL-750's
  // recovery-to-layer1 and CTL-770's resolveTargetSetpoint both read). It is
  // re-homed to the never-tuner-written `targetParallel` key instead.
  describe("executionCore.maxParallel is re-homed to targetParallel", () => {
    const withL2 = (mergedLayer2) => planLayer1Migration({ layer1: FULL_LAYER1(), mergedLayer2 });

    it("never writes maxParallel into node.json, even with an EMPTY Layer-2", () => {
      // The pre-remediation code took the `moves` arm here and wrote maxParallel
      // straight into node.json — the shadowing case, invisible on a host that
      // happened to already carry a Layer-2 maxParallel.
      const plan = withL2({ catalyst: {} });
      expect(movedPaths(plan)).not.toContain("orchestration.executionCore.maxParallel");
      expect(plan.nodePatch.catalyst.orchestration.executionCore.maxParallel).toBeUndefined();
    });

    it("seeds targetParallel from the Layer-1 maxParallel (empty Layer-2)", () => {
      const plan = withL2({ catalyst: {} });
      expect(movedPaths(plan)).toContain("orchestration.executionCore.targetParallel");
      expect(plan.nodePatch.catalyst.orchestration.executionCore.targetParallel).toBe(4);
      const move = plan.moves.find((m) => m.path === "orchestration.executionCore.targetParallel");
      expect(move.from).toBe("orchestration.executionCore.maxParallel");
      expect(move.scope).toBe("node");
    });

    it("seeds targetParallel even when Layer-2 already carries the runtime maxParallel mirror", () => {
      // This host's real state (measured): legacy Layer-2 carries maxParallel:4,
      // written by the autotuner. That must NOT suppress the setpoint seed —
      // suppressing it is exactly how setpoint went 4 → undefined after slimming.
      const plan = withL2({ catalyst: { orchestration: { executionCore: { maxParallel: 4 } } } });
      expect(plan.nodePatch.catalyst.orchestration.executionCore.targetParallel).toBe(4);
      expect(plan.nodePatch.catalyst.orchestration.executionCore.maxParallel).toBeUndefined();
    });

    it("does NOT overwrite an operator-declared targetParallel", () => {
      const plan = withL2({
        catalyst: { orchestration: { executionCore: { targetParallel: 9 } } },
      });
      expect(movedPaths(plan)).not.toContain("orchestration.executionCore.targetParallel");
      const kept = plan.kept.find((k) => k.path === "orchestration.executionCore.maxParallel");
      expect(kept).toBeDefined();
      expect(kept.existingValue).toBe(9);
    });

    it("still strips maxParallel from the slimmed Layer-1 in every branch", () => {
      for (const l2 of [
        { catalyst: {} },
        { catalyst: { orchestration: { executionCore: { maxParallel: 4 } } } },
        { catalyst: { orchestration: { executionCore: { targetParallel: 9 } } } },
      ]) {
        const plan = planLayer1Migration({ layer1: FULL_LAYER1(), mergedLayer2: l2 });
        expect(plan.slimmedLayer1.catalyst.orchestration).toBeUndefined();
      }
    });

    it("the sibling executionCore leaves still relocate normally", () => {
      const plan = withL2({ catalyst: {} });
      expect(plan.nodePatch.catalyst.orchestration.executionCore.minParallel).toBe(1);
      expect(plan.nodePatch.catalyst.orchestration.executionCore.maxParallelCeiling).toBe(40);
    });
  });

  // ── CTL-1214 remediation round 2: seeding an ALREADY-SLIM Layer-1 ──────────
  //
  // The re-home above only fires while Layer-1 still CARRIES maxParallel. But
  // this repo COMMITS a slimmed Layer-1, so on every host that pulls it the
  // migration finds nothing to relocate and targetParallel is never written by
  // anyone — migrate-layer1-config.mjs is its only writer in the tree. Measured
  // on mini-2: resolveTargetSetpoint 4 → null, which no-ops CTL-770's
  // convergence branches and (via rawTarget) nulls the layer1Max that RULE 7
  // recovery-to-layer1 compares against. Nothing errors; that is the failure.
  describe("targetParallel is seeded when Layer-1 is ALREADY SLIM", () => {
    // The shape this repo actually commits after Phase 3: identity only.
    const SLIM_LAYER1 = () => ({
      catalyst: {
        schemaVersion: 1,
        projectKey: "catalyst-workspace",
        project: { ticketPrefix: "CTL" },
        linear: { teamKey: "CTL" },
      },
    });

    it("seeds targetParallel from the merged Layer-2 maxParallel (the incident)", () => {
      // mini-2's real state: node.json carries min/ceiling but no maxParallel;
      // the legacy Layer-2 file carries the autotuner's mirror at 4.
      const plan = planLayer1Migration({
        layer1: SLIM_LAYER1(),
        mergedLayer2: {
          catalyst: {
            orchestration: { executionCore: { maxParallel: 4, minParallel: 1, maxParallelCeiling: 40 } },
          },
        },
      });
      expect(plan.changed).toBe(true);
      expect(plan.nodePatch.catalyst.orchestration.executionCore.targetParallel).toBe(4);
      const move = plan.moves.find((m) => m.path === "orchestration.executionCore.targetParallel");
      expect(move.value).toBe(4);
      expect(move.scope).toBe("node");
      // The provenance must say it came from the MERGED LAYER-2, not Layer-1 —
      // the two seeds have different trustworthiness and the operator-facing CLI
      // line is the only place that distinction is visible.
      expect(move.from).toContain("<merged Layer-2>");
    });

    it("is IDEMPOTENT — a seeded targetParallel is never re-seeded", () => {
      const mergedLayer2 = {
        catalyst: { orchestration: { executionCore: { maxParallel: 4, targetParallel: 4 } } },
      };
      const plan = planLayer1Migration({ layer1: SLIM_LAYER1(), mergedLayer2 });
      expect(movedPaths(plan)).not.toContain("orchestration.executionCore.targetParallel");
      expect(plan.changed).toBe(false);
    });

    it("does NOT clobber an operator's declared targetParallel with the live mirror", () => {
      const plan = planLayer1Migration({
        layer1: SLIM_LAYER1(),
        mergedLayer2: {
          catalyst: { orchestration: { executionCore: { maxParallel: 2, targetParallel: 9 } } },
        },
      });
      expect(plan.nodePatch.catalyst.orchestration?.executionCore?.targetParallel).toBeUndefined();
    });

    it("does NOT fire when Layer-1 still carries maxParallel — the committed target wins", () => {
      // Both arms could produce a seed here; the step-2 re-home must win, because
      // the committed operator target is better evidence than the tuner's mirror.
      const plan = planLayer1Migration({
        layer1: FULL_LAYER1(), // maxParallel: 4
        mergedLayer2: { catalyst: { orchestration: { executionCore: { maxParallel: 1 } } } },
      });
      const seeds = plan.moves.filter((m) => m.path === "orchestration.executionCore.targetParallel");
      expect(seeds).toHaveLength(1);
      expect(seeds[0].value).toBe(4);
      expect(seeds[0].from).toBe("orchestration.executionCore.maxParallel");
    });

    it("NEGATIVE CONTROL: no mirror anywhere → no seed, no write", () => {
      const plan = planLayer1Migration({ layer1: SLIM_LAYER1(), mergedLayer2: { catalyst: {} } });
      expect(plan.moves).toEqual([]);
      expect(plan.changed).toBe(false);
    });

    it("refuses a mirror that is not a positive integer", () => {
      // A seed that fails resolveTargetSetpoint's own Number.isInteger guard is a
      // write that LOOKS like a repair and changes nothing downstream.
      for (const maxParallel of [0, -1, null, "4", 2.5, true, {}]) {
        const plan = planLayer1Migration({
          layer1: SLIM_LAYER1(),
          mergedLayer2: { catalyst: { orchestration: { executionCore: { maxParallel } } } },
        });
        expect(plan.moves).toEqual([]);
      }
    });

    it("END TO END: the seed is what makes resolveTargetSetpoint stop returning undefined", () => {
      // The assertion that ties this fix to the symptom. Without it, every test
      // above could pass while the setpoint stayed null — they assert the PLAN,
      // this one asserts the CONSEQUENCE, through the real resolver.
      const layer1 = SLIM_LAYER1();
      const mergedLayer2 = {
        catalyst: { orchestration: { executionCore: { maxParallel: 4, minParallel: 1 } } },
      };
      const l1EC = layer1.catalyst.orchestration?.executionCore ?? {};

      // BEFORE: node.json has no targetParallel (the state the finding measured).
      expect(resolveTargetSetpoint(l1EC, {})).toBeUndefined();

      const plan = planLayer1Migration({ layer1, mergedLayer2 });
      const seededL2 = plan.nodePatch.catalyst.orchestration.executionCore;

      // AFTER: 4, matching pre-slim main.
      expect(resolveTargetSetpoint(l1EC, seededL2)).toBe(4);
    });
  });

  it("writes a whole stanza the merged Layer-2 defines nothing for", () => {
    const plan = planLayer1Migration({ layer1: FULL_LAYER1(), mergedLayer2: { catalyst: {} } });
    expect(movedPaths(plan)).toContain("sweep.idleHours");
    expect(movedPaths(plan)).toContain("sweep.intervalHours");
    expect(movedPaths(plan)).toContain("sweep.salvagePush");
    expect(movedPaths(plan)).toContain("sweep.maxRemovalsPerRun");
    expect(plan.nodePatch.catalyst.sweep.intervalHours).toBe(1);
    // `false` must survive: it is a real value, not an absence.
    expect(plan.nodePatch.catalyst.sweep.salvagePush).toBe(false);
  });

  it("a Layer-2 value of `false` still counts as DEFINED (jq-falsy trap)", () => {
    const plan = planLayer1Migration({
      layer1: FULL_LAYER1(),
      mergedLayer2: { catalyst: { sweep: { salvagePush: false } } },
    });
    expect(movedPaths(plan)).not.toContain("sweep.salvagePush");
    expect(keptPaths(plan)).toContain("sweep.salvagePush");
  });

  it("a Layer-2 value of `null` is NOT defined — null is an absence", () => {
    const plan = planLayer1Migration({
      layer1: FULL_LAYER1(),
      mergedLayer2: { catalyst: { sweep: { intervalHours: null } } },
    });
    expect(movedPaths(plan)).toContain("sweep.intervalHours");
  });
});

describe("planLayer1Migration — scope", () => {
  it("moves only RELOCATED_LAYER1_KEYS entries; identity is untouched", () => {
    const plan = planLayer1Migration({ layer1: FULL_LAYER1(), mergedLayer2: { catalyst: {} } });
    const slim = plan.slimmedLayer1.catalyst;
    expect(slim.projectKey).toBe("catalyst-workspace");
    expect(slim.project).toEqual({ ticketPrefix: "CTL" });
    expect(slim.linear.teamKey).toBe("CTL");
    expect(slim.linear.teamId).toBe("f317bf00");
    expect(slim.linear.stateMap).toEqual({ todo: "Todo", done: "Done" });
    expect(slim.thoughts.org).toBe("coalesce-labs");
    expect(slim.deployment).toEqual({ mode: "cluster" });
    for (const p of movedPaths(plan)) {
      expect(p.startsWith("projectKey") || p.startsWith("linear.") || p.startsWith("thoughts.")).toBe(false);
    }
  });

  it("does NOT move scope:'cluster' entries — monitor.linear.teams stays (D4)", () => {
    const plan = planLayer1Migration({ layer1: FULL_LAYER1(), mergedLayer2: { catalyst: {} } });
    expect(movedPaths(plan).join("|")).not.toContain("monitor.linear.teams");
    expect(plan.slimmedLayer1.catalyst.monitor.linear.teams).toHaveLength(1);
    expect(plan.nodePatch.catalyst.monitor?.linear).toBeUndefined();
  });

  it("moves monitor.github.repoColors (node-scoped) and leaves monitor itself intact", () => {
    const plan = planLayer1Migration({ layer1: FULL_LAYER1(), mergedLayer2: { catalyst: {} } });
    expect(movedPaths(plan)).toContain("monitor.github.repoColors");
    expect(plan.slimmedLayer1.catalyst.monitor.github).toBeUndefined();
    expect(plan.slimmedLayer1.catalyst.monitor.linear).toBeDefined();
    expect(plan.nodePatch.catalyst.monitor.github.repoColors).toEqual({
      "coalesce-labs/catalyst": "green",
    });
  });

  it("does NOT move the non-relocating orchestration stanzas (D6)", () => {
    const layer1 = FULL_LAYER1();
    layer1.catalyst.orchestration.codex = { codexHome: "/x/codex" };
    layer1.catalyst.orchestration.executor = "sdk";
    layer1.catalyst.orchestration.fleetHealth = { mode: "shadow" };
    const plan = planLayer1Migration({ layer1, mergedLayer2: { catalyst: {} } });
    const moved = movedPaths(plan).join("|");
    expect(moved).not.toContain("orchestration.codex");
    expect(moved).not.toContain("orchestration.executor");
    expect(moved).not.toContain("orchestration.fleetHealth");
    expect(plan.slimmedLayer1.catalyst.orchestration.codex).toEqual({ codexHome: "/x/codex" });
    expect(plan.slimmedLayer1.catalyst.orchestration.executor).toBe("sdk");
  });

  it("DROPS the dead eligibleQuery instead of relocating it", () => {
    const plan = planLayer1Migration({ layer1: FULL_LAYER1(), mergedLayer2: { catalyst: {} } });
    expect(plan.dropped.map((d) => d.path)).toContain(
      "orchestration.executionCore.eligibleQuery",
    );
    expect(movedPaths(plan).join("|")).not.toContain("eligibleQuery");
    expect(JSON.stringify(plan.nodePatch)).not.toContain("eligibleQuery");
    expect(JSON.stringify(plan.slimmedLayer1)).not.toContain("eligibleQuery");
  });

  it("removes the orchestration stanza entirely once its four members are gone", () => {
    const plan = planLayer1Migration({ layer1: FULL_LAYER1(), mergedLayer2: { catalyst: {} } });
    expect(plan.slimmedLayer1.catalyst.orchestration).toBeUndefined();
    expect(plan.slimmedLayer1.catalyst.feedback).toBeUndefined();
    expect(plan.slimmedLayer1.catalyst.sweep).toBeUndefined();
  });

  it("exports the relocated paths so the bash side cannot drift", () => {
    expect(Array.isArray(RELOCATED_PATHS)).toBe(true);
    expect(RELOCATED_PATHS).toContain("orchestration.dispatchMode");
    expect(RELOCATED_PATHS).toContain("sweep");
    expect(RELOCATED_PATHS).toContain("feedback");
  });
});

describe("planLayer1Migration — output shape", () => {
  it("stamps schemaVersion 1 on the slimmed Layer-1", () => {
    const plan = planLayer1Migration({ layer1: FULL_LAYER1(), mergedLayer2: { catalyst: {} } });
    expect(plan.slimmedLayer1.catalyst.schemaVersion).toBe(1);
  });

  it("preserves an existing higher schemaVersion", () => {
    const layer1 = FULL_LAYER1();
    layer1.catalyst.schemaVersion = 2;
    const plan = planLayer1Migration({ layer1, mergedLayer2: { catalyst: {} } });
    expect(plan.slimmedLayer1.catalyst.schemaVersion).toBe(2);
  });

  it("is idempotent: re-planning an already-slimmed config reports zero moves", () => {
    const first = planLayer1Migration({ layer1: FULL_LAYER1(), mergedLayer2: { catalyst: {} } });
    const second = planLayer1Migration({
      layer1: first.slimmedLayer1,
      mergedLayer2: first.nodePatch,
    });
    expect(second.moves).toHaveLength(0);
    expect(second.changed).toBe(false);
    // Positive control: the FIRST plan really did move things, so "zero moves"
    // above is convergence and not a planner that never moves anything.
    expect(first.moves.length).toBeGreaterThan(0);
    expect(first.changed).toBe(true);
  });

  it("rejects a malformed Layer-1 rather than guessing", () => {
    expect(() => planLayer1Migration({ layer1: null, mergedLayer2: { catalyst: {} } })).toThrow();
    expect(() => planLayer1Migration({ layer1: { nope: 1 }, mergedLayer2: { catalyst: {} } })).toThrow();
    expect(() => planLayer1Migration({ layer1: [], mergedLayer2: { catalyst: {} } })).toThrow();
  });
});

describe("applyLayer1Migration — atomic writes and ordering", () => {
  const setup = (layer1Obj, nodeObj) => {
    const d = mkdir();
    const l1 = join(d, "config.json");
    const node = join(d, "node.json");
    writeFileSync(l1, JSON.stringify(layer1Obj, null, 2));
    if (nodeObj !== undefined) writeFileSync(node, JSON.stringify(nodeObj, null, 2));
    return { d, l1, node };
  };

  it("creates node.json 0600 when absent and slims Layer-1", () => {
    const { l1, node } = setup(FULL_LAYER1());
    const plan = planLayer1Migration({ layer1: FULL_LAYER1(), mergedLayer2: { catalyst: {} } });
    const res = applyLayer1Migration({ plan, layer1Path: l1, nodePath: node });
    expect(res.wrote).toEqual(expect.arrayContaining([node, l1]));
    expect(statSync(node).mode & 0o777).toBe(0o600);
    const written = JSON.parse(readFileSync(node, "utf8"));
    expect(written.catalyst.orchestration.dispatchMode).toBe("phase-agents");
    const slim = JSON.parse(readFileSync(l1, "utf8"));
    expect(slim.catalyst.orchestration).toBeUndefined();
    expect(slim.catalyst.schemaVersion).toBe(1);
  });

  it("deep-merges an existing node.json, never replaces it", () => {
    const { l1, node } = setup(FULL_LAYER1(), {
      catalyst: { host: { name: "mini-2" }, orchestration: { pluginDirs: "/x" } },
    });
    const plan = planLayer1Migration({ layer1: FULL_LAYER1(), mergedLayer2: { catalyst: {} } });
    applyLayer1Migration({ plan, layer1Path: l1, nodePath: node });
    const written = JSON.parse(readFileSync(node, "utf8"));
    expect(written.catalyst.host.name).toBe("mini-2");
    expect(written.catalyst.orchestration.pluginDirs).toBe("/x");
    expect(written.catalyst.orchestration.dispatchMode).toBe("phase-agents");
  });

  it("--dry-run writes nothing", () => {
    const { l1, node } = setup(FULL_LAYER1());
    const before = readFileSync(l1, "utf8");
    const plan = planLayer1Migration({ layer1: FULL_LAYER1(), mergedLayer2: { catalyst: {} } });
    const res = applyLayer1Migration({ plan, layer1Path: l1, nodePath: node, dryRun: true });
    expect(res.wrote).toEqual([]);
    expect(readFileSync(l1, "utf8")).toBe(before);
    expect(existsSync(node)).toBe(false);
  });

  it("an unwritable node.json leaves Layer-1 UNSLIMMED (never slim-then-fail)", () => {
    // The load-bearing ordering assertion: node.json is written FIRST, so a
    // failure can never leave a repo slimmed with its values nowhere.
    const { d, l1, node } = setup(FULL_LAYER1());
    const before = readFileSync(l1, "utf8");
    chmodSync(d, 0o500); // read+execute only: no new file may be created
    const plan = planLayer1Migration({ layer1: FULL_LAYER1(), mergedLayer2: { catalyst: {} } });
    expect(() => applyLayer1Migration({ plan, layer1Path: l1, nodePath: node })).toThrow();
    chmodSync(d, 0o755);
    expect(readFileSync(l1, "utf8")).toBe(before);
  });

  // ── CTL-1214 remediation: the DESTINATION file fails closed too ──────────
  //
  // The plan already refuses a malformed Layer-1 INPUT (planLayer1Migration
  // throws). The destination read swallowed every error to `{}`, so an existing
  // but malformed/unreadable node.json was silently REPLACED by the patch instead
  // — losing every other node-scoped key the operator had there. ENOENT is the
  // only "start fresh" case.
  it("refuses to overwrite a MALFORMED node.json, and leaves Layer-1 unslimmed", () => {
    const { d, l1, node } = setup(FULL_LAYER1());
    writeFileSync(node, "{ this is not json");
    const before = readFileSync(l1, "utf8");
    const plan = planLayer1Migration({ layer1: FULL_LAYER1(), mergedLayer2: { catalyst: {} } });
    expect(() => applyLayer1Migration({ plan, layer1Path: l1, nodePath: node })).toThrow(
      /refusing to overwrite malformed config/,
    );
    // Both halves: the destination is intact AND the ordering guarantee holds.
    expect(readFileSync(node, "utf8")).toBe("{ this is not json");
    expect(readFileSync(l1, "utf8")).toBe(before);
    expect(d).toBeDefined();
  });

  it("refuses a node.json that parses to a NON-OBJECT (malformed, not empty)", () => {
    const { l1, node } = setup(FULL_LAYER1());
    writeFileSync(node, "[1,2,3]");
    const plan = planLayer1Migration({ layer1: FULL_LAYER1(), mergedLayer2: { catalyst: {} } });
    expect(() => applyLayer1Migration({ plan, layer1Path: l1, nodePath: node })).toThrow(
      /not a JSON object/,
    );
  });

  it("refuses an UNREADABLE node.json rather than replacing it", () => {
    const { l1, node } = setup(FULL_LAYER1(), { catalyst: { host: { name: "mini-2" } } });
    chmodSync(node, 0o000);
    const plan = planLayer1Migration({ layer1: FULL_LAYER1(), mergedLayer2: { catalyst: {} } });
    let threw = false;
    try {
      applyLayer1Migration({ plan, layer1Path: l1, nodePath: node });
    } catch (err) {
      threw = true;
      expect(err.message).toMatch(/refusing to overwrite unreadable config/);
    }
    chmodSync(node, 0o600);
    // POSITIVE CONTROL: running as root would make the read succeed and this
    // assertion vacuous, so assert the file is still the operator's, not the patch.
    expect(JSON.parse(readFileSync(node, "utf8")).catalyst.host.name).toBe("mini-2");
    expect(threw).toBe(true);
  });

  // NEGATIVE CONTROL for the three above: an ABSENT node.json must still be the
  // start-fresh path, or the fail-closed change would break every first migration.
  it("an ABSENT node.json is still start-fresh, not a refusal", () => {
    const { l1, node } = setup(FULL_LAYER1());
    const plan = planLayer1Migration({ layer1: FULL_LAYER1(), mergedLayer2: { catalyst: {} } });
    expect(() => applyLayer1Migration({ plan, layer1Path: l1, nodePath: node })).not.toThrow();
    expect(existsSync(node)).toBe(true);
  });

  it("re-running is a no-op: second apply writes nothing", () => {
    const { l1, node } = setup(FULL_LAYER1());
    const plan = planLayer1Migration({ layer1: FULL_LAYER1(), mergedLayer2: { catalyst: {} } });
    applyLayer1Migration({ plan, layer1Path: l1, nodePath: node });

    const layer1b = JSON.parse(readFileSync(l1, "utf8"));
    const nodeb = JSON.parse(readFileSync(node, "utf8"));
    const plan2 = planLayer1Migration({ layer1: layer1b, mergedLayer2: nodeb });
    const res2 = applyLayer1Migration({ plan: plan2, layer1Path: l1, nodePath: node });
    expect(res2.wrote).toEqual([]);
    expect(plan2.moves).toHaveLength(0);
  });

  it("leaves no .tmp residue behind", () => {
    const { d, l1, node } = setup(FULL_LAYER1());
    const plan = planLayer1Migration({ layer1: FULL_LAYER1(), mergedLayer2: { catalyst: {} } });
    applyLayer1Migration({ plan, layer1Path: l1, nodePath: node });
    const { readdirSync } = require("node:fs");
    expect(readdirSync(d).filter((f) => f.includes(".tmp"))).toEqual([]);
  });
});

describe("catalyst-config-migrate CLI", () => {
  const CLI = join(import.meta.dir, "..", "catalyst-config-migrate");
  const run = (args, env = {}) =>
    Bun.spawnSync(["bun", CLI, ...args], {
      env: { ...process.env, ...env },
      stdout: "pipe",
      stderr: "pipe",
    });

  it("--paths prints the registry, so the bash side never re-types it", () => {
    const r = run(["--paths"]);
    expect(r.exitCode).toBe(0);
    const lines = new TextDecoder().decode(r.stdout).trim().split("\n");
    expect(lines).toContain("orchestration.dispatchMode");
    expect(lines).toContain("sweep");
    expect(lines).toContain("feedback");
    expect(lines).toContain("monitor.linear.teams");
    // Positive control: it is the REGISTRY, not a hardcoded list — the count
    // must match RELOCATED_PATHS exactly.
    expect(lines).toHaveLength(RELOCATED_PATHS.length);
  });

  it("--help exits 0 and an unknown flag exits non-zero", () => {
    expect(run(["--help"]).exitCode).toBe(0);
    expect(run(["--no-such-flag"]).exitCode).not.toBe(0);
  });

  it("--dry-run reports the moves and writes nothing", () => {
    // Layer-1 and node.json live in SEPARATE directories, as they do in
    // production (<repo>/.catalyst/config.json vs ~/.config/catalyst/node.json).
    // The CLI resolves the merged Layer-2 root as node.json's sibling
    // config.json; sharing one dir would make the Layer-1 file masquerade as
    // Layer-2, so every key would look already-defined and nothing would move.
    const d = mkdir();
    const l1 = join(d, "config.json");
    const node = join(mkdir(), "node.json");
    writeFileSync(l1, JSON.stringify(FULL_LAYER1(), null, 2));
    const before = readFileSync(l1, "utf8");

    const r = run(["--dry-run", "--json", "--config", l1, "--node", node]);
    expect(r.exitCode).toBe(0);
    const report = JSON.parse(new TextDecoder().decode(r.stdout));
    expect(report.dryRun).toBe(true);
    expect(report.wrote).toEqual([]);
    expect(report.moved.map((m) => m.path)).toContain("orchestration.dispatchMode");
    expect(report.dropped.map((x) => x.path)).toContain(
      "orchestration.executionCore.eligibleQuery",
    );
    expect(readFileSync(l1, "utf8")).toBe(before);
    expect(existsSync(node)).toBe(false);
  });

  it("a real run migrates, and a second run is a clean no-op", () => {
    const d = mkdir();
    const l1 = join(d, "config.json");
    const node = join(mkdir(), "node.json");
    writeFileSync(l1, JSON.stringify(FULL_LAYER1(), null, 2));

    const first = run(["--json", "--config", l1, "--node", node]);
    expect(first.exitCode).toBe(0);
    const r1 = JSON.parse(new TextDecoder().decode(first.stdout));
    expect(r1.wrote).toContain(node);
    expect(r1.wrote).toContain(l1);
    expect(statSync(node).mode & 0o777).toBe(0o600);

    const second = run(["--json", "--config", l1, "--node", node]);
    expect(second.exitCode).toBe(0);
    const r2 = JSON.parse(new TextDecoder().decode(second.stdout));
    expect(r2.changed).toBe(false);
    expect(r2.moved).toEqual([]);
    expect(r2.wrote).toEqual([]);
    // Positive control: the FIRST run really did move things, so the no-op above
    // is convergence rather than a CLI that never migrates anything.
    expect(r1.moved.length).toBeGreaterThan(0);
  });

  it("a malformed Layer-1 exits non-zero and writes nothing", () => {
    const d = mkdir();
    const l1 = join(d, "config.json");
    const node = join(mkdir(), "node.json");
    writeFileSync(l1, "{ not json at all");
    const r = run(["--config", l1, "--node", node]);
    expect(r.exitCode).not.toBe(0);
    expect(new TextDecoder().decode(r.stderr)).toContain("malformed");
    expect(existsSync(node)).toBe(false);
  });

  it("a missing Layer-1 exits non-zero", () => {
    const r = run(["--config", "/no/such/config.json", "--node", "/tmp/x-node.json"]);
    expect(r.exitCode).not.toBe(0);
  });
});
