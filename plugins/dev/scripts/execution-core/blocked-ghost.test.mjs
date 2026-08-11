import { describe, expect, mock, test } from "bun:test";
import {
  createConfiguredBlockedGhostProbe,
  makeBlockedGhostAwareIsBgJobAlive,
} from "./blocked-ghost.mjs";

const sessionId = "5ad5c1ff-0000-0000-0000-000000000000";
const blocked = [{ sessionId, kind: "background", status: "idle", state: "blocked" }];
const working = [{ sessionId, kind: "background", status: "busy", state: "working" }];

describe("makeBlockedGhostAwareIsBgJobAlive (CAT-171)", () => {
  test("configured builder honors enforce and defaults to shadow", () => {
    const agents = [{ sessionId: "aaaaaaaa", state: "blocked" }];
    const enforce = createConfiguredBlockedGhostProbe({
      env: { CATALYST_BLOCKED_GHOST: "enforce" },
      base: () => true,
      emit: () => {},
      emitReap: () => true,
    });
    const shadow = createConfiguredBlockedGhostProbe({
      env: {},
      base: () => true,
      emit: () => {},
      emitReap: () => true,
    });
    expect(enforce("aaaaaaaa-0000", { agents })).toBe(false);
    expect(shadow("aaaaaaaa-0000", { agents })).toBe(true);
  });

  test("configured builder remains a fail-open function when hooks throw", () => {
    const probe = createConfiguredBlockedGhostProbe({
      env: {},
      base: () => true,
      emit: () => { throw new Error("telemetry down"); },
      emitReap: () => { throw new Error("append down"); },
    });
    expect(typeof probe).toBe("function");
    expect(probe("aaaaaaaa-0000", {
      agents: [{ sessionId: "aaaaaaaa", state: "blocked" }],
    })).toBe(true);
  });

  test("off delegates to the base probe without events", () => {
    const emit = mock();
    const probe = makeBlockedGhostAwareIsBgJobAlive({ mode: "off", emit });
    expect(probe(sessionId, { agents: blocked })).toBe(true);
    expect(emit).not.toHaveBeenCalled();
  });

  test("shadow keeps the session alive and emits one observation", () => {
    const emit = mock();
    const probe = makeBlockedGhostAwareIsBgJobAlive({ mode: "shadow", emit });
    expect(probe(sessionId, { agents: blocked })).toBe(true);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][0]).toBe("liveness.blocked-ghost.observed");
  });

  test("shadow observations are deduplicated per wrapper and session", () => {
    const emit = mock();
    const probe = makeBlockedGhostAwareIsBgJobAlive({ mode: "shadow", emit });
    probe(sessionId, { agents: blocked });
    probe(sessionId, { agents: blocked });
    probe(sessionId, { agents: blocked });
    expect(emit).toHaveBeenCalledTimes(1);
  });

  test("enforce classifies a blocked listing as not alive", () => {
    const emit = mock();
    const probe = makeBlockedGhostAwareIsBgJobAlive({ mode: "enforce", emit });
    expect(probe(sessionId, { agents: blocked })).toBe(false);
    expect(emit.mock.calls[0][0]).toBe("liveness.blocked-ghost.reclaimable");
  });

  test("non-blocked sessions are untouched in every mode", () => {
    for (const mode of ["off", "shadow", "enforce"]) {
      const emit = mock();
      const probe = makeBlockedGhostAwareIsBgJobAlive({ mode, emit });
      expect(probe(sessionId, { agents: working })).toBe(true);
      expect(emit).not.toHaveBeenCalled();
    }
  });

  test("absent sessions remain not alive without events", () => {
    const emit = mock();
    const probe = makeBlockedGhostAwareIsBgJobAlive({ mode: "enforce", emit });
    expect(probe(sessionId, { agents: [] })).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });

  test("throwing telemetry never changes the verdict", () => {
    const probe = makeBlockedGhostAwareIsBgJobAlive({
      mode: "enforce",
      emit: () => {
        throw new Error("event log down");
      },
    });
    expect(probe(sessionId, { agents: blocked })).toBe(false);
  });

  test("enforce emits one reap intent per ghost", () => {
    const emitReap = mock();
    const probe = makeBlockedGhostAwareIsBgJobAlive({
      mode: "enforce",
      emit: () => {},
      emitReap,
    });
    probe(sessionId, { agents: blocked });
    probe(sessionId, { agents: blocked });
    expect(emitReap).toHaveBeenCalledTimes(1);
    expect(emitReap.mock.calls[0][0]).toBe("phase.terminal.reap-requested");
    expect(emitReap.mock.calls[0][1]).toMatchObject({
      reason: "cat-171-blocked-ghost",
      bgJobId: sessionId,
    });
  });

  test("shadow never emits a reap intent", () => {
    const emitReap = mock();
    const probe = makeBlockedGhostAwareIsBgJobAlive({ mode: "shadow", emit: () => {}, emitReap });
    probe(sessionId, { agents: blocked });
    expect(emitReap).not.toHaveBeenCalled();
  });

  test("throwing reap emission never changes the enforce verdict", () => {
    const probe = makeBlockedGhostAwareIsBgJobAlive({
      mode: "enforce",
      emit: () => {},
      emitReap: () => {
        throw new Error("down");
      },
    });
    expect(probe(sessionId, { agents: blocked })).toBe(false);
  });

  test("a failed reap append is retried on the next classification", () => {
    const emitReap = mock(() => false);
    const probe = makeBlockedGhostAwareIsBgJobAlive({
      mode: "enforce",
      emit: () => {},
      emitReap,
    });
    probe(sessionId, { agents: blocked });
    probe(sessionId, { agents: blocked });
    expect(emitReap).toHaveBeenCalledTimes(2);
  });
});
