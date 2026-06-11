// board-snapshot.mjs — CTL-733 reactive board snapshot manager.
//
// CTL-883: this is now a THIN SPECIALIZATION of the generalized read-model core
// (lib/read-model.mjs). The proven push model — compute ONCE for all connected
// clients and fan out over SSE instead of each browser tab polling /api/board
// on its own 4s timer — was lifted verbatim into createReadModel and extended to
// serve tickets/workers/queue/run-records as named entities. The board snapshot
// is simply the `board` view of that read-model, so the existing server wiring
// (createBoardSnapshotManager().subscribe/getLatest) and every board-snapshot
// test keep working unchanged — a concrete demonstration of the "no route code
// changes because it consumes the module interface" requirement.
//
// Recomputed reactively (debounced) on:
//   • fs.watch(execution-core/workers/) — phase-signal file changes, and
//   • a periodic poll (the shared `claude agents` cadence),
// and only while at least one SSE client is subscribed (zero host cost when idle).
//
// Emits the FULL snapshot on each recompute (the payload is a few KB and board
// state is derived — a delta protocol is a later optimization, per CTL-733).

import { createReadModel } from "./read-model.mjs";
import { assembleBoard } from "./board-data.mjs";

export function createBoardSnapshotManager({
  debounceMs = 1000,
  pollMs = 3000,
  onDemandTtlMs = 2000,
  assemble = assembleBoard,
  workersDir,
} = {}) {
  const model = createReadModel({
    debounceMs,
    pollMs,
    onDemandTtlMs,
    assemble,
    ...(workersDir ? { workersDir } : {}),
  });
  return {
    subscribe: model.subscribe,
    // getLatest is the board-snapshot name for the read-model's getSnapshot.
    getLatest: model.getSnapshot,
    stop: model.stop,
    get subscriberCount() {
      return model.subscriberCount;
    },
  };
}
