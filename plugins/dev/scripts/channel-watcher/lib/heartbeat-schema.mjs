// heartbeat-schema.mjs — CTL-1423. Single source of truth for the
// channel-watcher event/service names and heartbeat label keys.
// Imported by the watcher, the broker recency extension, and the tests so the
// emitter, detector, and catalyst-otel LogQL rule can never drift.

export const CHANNEL_WATCHER_SERVICE_NAME = "catalyst.channel-watcher";
export const CHANNEL_WATCHER_HEARTBEAT_EVENT = "channel.watcher.heartbeat";
export const CHANNEL_WATCHER_TURN_EVENT = "channel.watcher.turn-detected";

// Structured-metadata keys carried in the heartbeat payload/attributes.
// host.name + watcher.id + watcher.channel form the dead-man's-switch identity
// tuple; baseline_turn pins the watcher's arming point.
export function heartbeatLabelKeys() {
  return ["host.name", "watcher.id", "watcher.channel", "watcher.baseline_turn"];
}
