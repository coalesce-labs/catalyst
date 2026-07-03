import { test, expect } from "bun:test";
import {
  CHANNEL_WATCHER_HEARTBEAT_EVENT,
  CHANNEL_WATCHER_TURN_EVENT,
  CHANNEL_WATCHER_SERVICE_NAME,
  heartbeatLabelKeys,
} from "../lib/heartbeat-schema.mjs";

test("event + service names are the frozen contract strings", () => {
  expect(CHANNEL_WATCHER_HEARTBEAT_EVENT).toBe("channel.watcher.heartbeat");
  expect(CHANNEL_WATCHER_TURN_EVENT).toBe("channel.watcher.turn-detected");
  expect(CHANNEL_WATCHER_SERVICE_NAME).toBe("catalyst.channel-watcher");
});

test("label keys include host, watcher id, channel, baseline turn", () => {
  expect(heartbeatLabelKeys()).toEqual(
    expect.arrayContaining(["host.name", "watcher.id", "watcher.channel", "watcher.baseline_turn"]),
  );
});
