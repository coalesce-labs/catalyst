// process-route.tsx — REASON › Process surface (CTL-1101 Phase 3 + Phase 4).
// Fetches /api/fsm/descriptor once, builds the pure model, renders the RF canvas.
// Phase 4 adds SourceSheet (edge-click popover), ProcessRail (legend/facts/mirror), and MachineFooter.
import { useCallback, useEffect, useRef, useState } from "react";
import { C } from "../../board/board-tokens";
import { buildProcessModel, type ProcessModel, type FsmDescriptor } from "../../lib/process-model";
import { ProcessSurface } from "../../board/process-canvas";
import { ProcessRail } from "../governance/process-rail";
import { SourceSheet } from "../governance/source-sheet";
import type { SourceTarget } from "../governance/source-target";

export function ProcessRoute() {
  const [model, setModel] = useState<ProcessModel | null>(null);
  const [descriptor, setDescriptor] = useState<FsmDescriptor | null>(null);
  const [error, setError] = useState<string | null>(null);
  const prevShaRef = useRef<string | null>(null);
  const [sheetTarget, setSheetTarget] = useState<SourceTarget | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch("/api/fsm/descriptor")
      .then((r) => {
        if (!r.ok) throw new Error(`/api/fsm/descriptor ${r.status}`);
        return r.json() as Promise<FsmDescriptor>;
      })
      .then((d) => {
        if (!alive) return;
        setDescriptor(d);
        setModel(buildProcessModel(d));
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, []);

  // Track prevSha after first load (session-scoped; not state so it doesn't re-render).
  useEffect(() => {
    if (descriptor?.descriptorSha && prevShaRef.current === null) {
      prevShaRef.current = descriptor.descriptorSha;
    }
  }, [descriptor]);

  const handleEdgeClick = useCallback((from: string, to: string) => {
    setSheetTarget({ kind: "edge", from, to });
    setSheetOpen(true);
  }, []);

  const handleOpenSource = useCallback((target: { kind: "edge"; from: string; to: string }) => {
    setSheetTarget(target);
    setSheetOpen(true);
  }, []);

  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
      style={{ background: C.s1, color: C.fg }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          padding: "10px 16px",
          flex: "0 0 auto",
          borderBottom: `1px solid ${C.borderSubtle}`,
        }}
      >
        <h1 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Process</h1>
        <span style={{ color: C.fgMuted, fontSize: 12 }}>
          FSM pipeline · rendered from descriptor
        </span>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        {error ? (
          <div style={{ padding: 24, color: C.red, fontSize: 13 }}>
            Failed to load descriptor: {error}
          </div>
        ) : !model || !descriptor ? (
          <div style={{ padding: 24, color: C.fgMuted, fontSize: 13 }}>
            Loading process map…
          </div>
        ) : (
          <ProcessSurface model={model} onEdgeClick={handleEdgeClick}>
            <ProcessRail
              descriptor={descriptor}
              descriptorSha={descriptor.descriptorSha ?? null}
              prevSha={prevShaRef.current}
              onOpenSource={handleOpenSource}
            />
          </ProcessSurface>
        )}
      </div>

      <SourceSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        target={sheetTarget}
        manifest={null}
        descriptor={descriptor}
      />
    </div>
  );
}
