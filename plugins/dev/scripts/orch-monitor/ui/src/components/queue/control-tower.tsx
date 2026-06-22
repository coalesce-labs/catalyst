import { useState } from "react";
import type { BoardPayload } from "../../board/types";
import { C } from "../../board/board-tokens";
import { queueHostMode } from "../../board/queue-grouping";
import { SlotDeck } from "./slot-deck";
import { DispatchQueue } from "./dispatch-queue";
import { HoldingBuckets } from "./holding-buckets";
import { DeadStrip } from "./dead-strip";
import { NodeFilter } from "./node-filter";
import { isClusterMode } from "./cluster-capacity";
import { useClusterSignalContext } from "@/hooks/use-cluster-signal";

export function ControlTower({
  payload,
  onOpenTicket,
}: {
  payload: BoardPayload;
  onOpenTicket: (key: string) => void;
}) {
  const multiHost = queueHostMode(payload.queue) === "multi";
  const cluster = useClusterSignalContext();
  const clusterMode = isClusterMode(cluster);
  const [selectedNode, setSelectedNode] = useState<string | "all">("all");

  return (
    <div style={{ maxWidth: 1120, margin: "0 auto", padding: "8px 24px 32px", display: "flex", flexDirection: "column", gap: 28 }}>
      {clusterMode && cluster && (
        <NodeFilter
          nodes={cluster.nodes}
          selected={selectedNode}
          onSelect={setSelectedNode}
        />
      )}
      <SlotDeck
        workers={payload.workers}
        tickets={payload.tickets}
        config={payload.config}
        onOpenTicket={onOpenTicket}
        clusterSignal={clusterMode ? cluster : null}
        selectedNode={clusterMode ? selectedNode : "all"}
      />
      <DispatchQueue
        queue={payload.queue}
        freeSlots={payload.config.freeSlots}
        onOpenTicket={onOpenTicket}
      />
      <HoldingBuckets
        tickets={payload.tickets}
        workers={payload.workers}
        maxParallel={payload.config.maxParallel}
        onOpenTicket={onOpenTicket}
      />
      <DeadStrip
        workers={payload.workers}
        tickets={payload.tickets}
        maxParallel={payload.config.maxParallel}
      />
      <div style={{ fontSize: 11, color: C.fgDim }}>
        Dispatch order: priority → pipeline stage → created → id — the same rank the scheduler uses.
        Per-project caps apply at dispatch time. Blocked work never enters this line.
        {multiHost ? " Node = the HRW owner host for each queued ticket." : ""}
      </div>
    </div>
  );
}
