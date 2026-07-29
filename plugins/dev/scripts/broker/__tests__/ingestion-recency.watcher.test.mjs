// ingestion-recency.watcher.test.mjs — CTL-1423 Phase 5. Spec for the
// per-watcher dead-man's switch state machine exported by ingestion-recency.mjs.
// Pure units — explicit nowMs/ts controls, no I/O.
import { test, expect } from "bun:test";
import { makeWatcherRecency } from "../ingestion-recency.mjs";
import { CHANNEL_WATCHER_HEARTBEAT_EVENT } from "../../channel-watcher/lib/heartbeat-schema.mjs";

const INTERVAL = 60_000; // 1 minute, matches default watcher cadence

// Build a minimal heartbeat envelope matching the shape the watcher emits.
function hb({ watcherId, channel, host = "mini", ts = 0 }) {
  return {
    ts: new Date(ts).toISOString(),
    id: `hb-${ts}-${watcherId}`,
    resource: { "service.name": "catalyst.channel-watcher" },
    attributes: { "event.name": CHANNEL_WATCHER_HEARTBEAT_EVENT },
    body: {
      payload: {
        "watcher.id": watcherId,
        "watcher.channel": channel,
        "host.name": host,
      },
    },
  };
}

test("silent watcher raises system_down once on the stale edge", () => {
  const d = makeWatcherRecency({ staleAfterMs: 3 * INTERVAL });
  d.observe(hb({ watcherId: "w1", channel: "fleet-reinstall-rollout.md", ts: 0 }));
  const raised = d.tick(4 * INTERVAL);           // past N intervals of silence
  expect(raised).toMatchObject({ action: "raised", label: "system_down" });
  expect(d.tick(5 * INTERVAL)).toBeNull();       // no double-raise while still stale
});

test("resumed heartbeat clears system_down", () => {
  const d = makeWatcherRecency({ staleAfterMs: 3 * INTERVAL });
  d.observe(hb({ watcherId: "w1", channel: "fleet-reinstall-rollout.md", ts: 0 }));
  d.tick(4 * INTERVAL);   // stale → raised (consumed)
  // fresh heartbeat arrives after the stale window
  d.observe(hb({ watcherId: "w1", channel: "fleet-reinstall-rollout.md", ts: 4.5 * INTERVAL }));
  const cleared = d.tick(6 * INTERVAL); // 1.5 intervals old — fresh → cleared
  expect(cleared).toMatchObject({ action: "cleared", label: "system_down" });
  expect(d.tick(7 * INTERVAL)).toBeNull(); // no double-cleared
});

test("fresh heartbeats within the stale window never raise", () => {
  const d = makeWatcherRecency({ staleAfterMs: 3 * INTERVAL });
  d.observe(hb({ watcherId: "w1", channel: "fleet-reinstall-rollout.md", ts: 0 }));
  expect(d.tick(1 * INTERVAL)).toBeNull(); // 1 interval old, not stale
  expect(d.tick(2 * INTERVAL)).toBeNull(); // 2 intervals old, not stale
  d.observe(hb({ watcherId: "w1", channel: "fleet-reinstall-rollout.md", ts: 2.5 * INTERVAL }));
  expect(d.tick(3.5 * INTERVAL)).toBeNull(); // 1 interval since last hb
});

test("never-seen tracker stays fail-open (unknown → no alarm)", () => {
  const d = makeWatcherRecency({ staleAfterMs: 3 * INTERVAL });
  // no observe — a broker restarted without seeing this watcher yet must not raise
  expect(d.tick(10 * INTERVAL)).toBeNull();
  expect(d.tick(100 * INTERVAL)).toBeNull();
});
