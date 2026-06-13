// node-filter.tsx — CTL-1092 Phase 4. Presentational node tab strip for the
// Workers view. Shown only in cluster mode (isClusterMode guard in ControlTower).
import { C } from "../../board/board-tokens";
import type { ClusterSignalNode } from "@/lib/cluster-signal";

export interface NodeFilterProps {
  nodes: readonly ClusterSignalNode[];
  selected: string | "all";
  onSelect: (node: string | "all") => void;
}

function statusDot(status: string): string {
  if (status === "live") return "#4ade80";
  if (status === "degraded") return "#facc15";
  return "#6b7280";
}

export function NodeFilter({ nodes, selected, onSelect }: NodeFilterProps) {
  const tabs: Array<{ key: string | "all"; label: string; dot?: string; sub?: string }> = [
    { key: "all", label: "All nodes" },
    ...nodes.map((n) => ({
      key: n.host,
      label: n.host,
      dot: statusDot(n.status),
      sub: n.status === "offline"
        ? "offline"
        : n.inFlightCount != null && n.maxParallel != null
          ? `${n.inFlightCount}/${n.maxParallel}`
          : undefined,
    })),
  ];

  return (
    <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
      {tabs.map((tab) => {
        const active = selected === tab.key;
        return (
          <button
            key={tab.key}
            type="button"
            onClick={() => onSelect(tab.key)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "4px 10px",
              borderRadius: 6,
              border: `1px solid ${active ? C.blue : C.borderSubtle}`,
              background: active ? "rgba(59,130,246,0.12)" : "transparent",
              color: active ? C.blue : C.fgMuted,
              fontFamily: C.mono,
              fontSize: 11,
              cursor: "pointer",
            }}
          >
            {tab.dot && (
              <span
                style={{
                  width: 6, height: 6, borderRadius: "50%",
                  background: tab.dot, display: "inline-block", flexShrink: 0,
                }}
              />
            )}
            <span>{tab.label}</span>
            {tab.sub && (
              <span style={{ color: C.fgDim, fontSize: 10 }}>{tab.sub}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
