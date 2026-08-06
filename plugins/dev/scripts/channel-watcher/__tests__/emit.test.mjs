import { test, expect } from "bun:test";
import { buildWatcherHeartbeat, buildTurnDetected } from "../lib/emit.mjs";
import {
  CHANNEL_WATCHER_HEARTBEAT_EVENT,
  CHANNEL_WATCHER_TURN_EVENT,
  CHANNEL_WATCHER_SERVICE_NAME,
} from "../lib/heartbeat-schema.mjs";

const cfg = {
  watcherId: "w1",
  channel: "fleet-reinstall-rollout.md",
  baselineTurn: 116,
  host: "mini",
};

test("heartbeat envelope carries the identity tuple + current turn", () => {
  const e = buildWatcherHeartbeat({
    ...cfg,
    currentTurn: 118,
    now: () => "2026-07-03T10:00:00Z",
  });
  expect(e.attributes["event.name"]).toBe(CHANNEL_WATCHER_HEARTBEAT_EVENT);
  expect(e.resource["service.name"]).toBe(CHANNEL_WATCHER_SERVICE_NAME);
  expect(e.body.payload["watcher.id"]).toBe("w1");
  expect(e.body.payload["watcher.channel"]).toBe("fleet-reinstall-rollout.md");
  expect(e.body.payload["watcher.baseline_turn"]).toBe(116);
  expect(e.body.payload["watcher.current_turn"]).toBe(118);
});

test("heartbeat has required OTel envelope fields", () => {
  const e = buildWatcherHeartbeat({
    ...cfg,
    currentTurn: 116,
    now: () => "2026-07-03T10:00:00Z",
  });
  expect(e.ts).toBe("2026-07-03T10:00:00Z");
  expect(e.severityText).toBe("INFO");
  expect(e.resource["service.namespace"]).toBe("catalyst");
  expect(typeof e.id).toBe("string");
});

test("turn-detected fires only when currentTurn > baselineTurn", () => {
  expect(buildTurnDetected({ ...cfg, currentTurn: 116 })).toBeNull();
  expect(buildTurnDetected({ ...cfg, currentTurn: 115 })).toBeNull();
  expect(buildTurnDetected({ ...cfg, currentTurn: 117 })).not.toBeNull();
});

test("turn-detected envelope has correct event name", () => {
  const e = buildTurnDetected({
    ...cfg,
    currentTurn: 117,
    now: () => "2026-07-03T10:00:00Z",
  });
  expect(e.attributes["event.name"]).toBe(CHANNEL_WATCHER_TURN_EVENT);
  expect(e.body.payload["watcher.current_turn"]).toBe(117);
});
