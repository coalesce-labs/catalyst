// process-route.tsx — REASON › Process surface (CTL-1101 Phase 3).
// Fetches /api/fsm/descriptor once, builds the pure model, renders the RF canvas.
import { useEffect, useRef, useState } from "react";
import { C } from "../../board/board-tokens";
import { buildProcessModel, type ProcessModel, type FsmDescriptor } from "../../lib/process-model";
import { ProcessSurface } from "../../board/process-canvas";

export function ProcessRoute() {
  const [model, setModel] = useState<ProcessModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Phase 4 reads prevShaRef to flash the "machine changed" chip.
  const prevShaRef = useRef<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/fsm/descriptor")
      .then((r) => {
        if (!r.ok) throw new Error(`/api/fsm/descriptor ${r.status}`);
        return r.json() as Promise<FsmDescriptor>;
      })
      .then((descriptor) => {
        if (!alive) return;
        prevShaRef.current = descriptor.descriptorSha ?? null;
        setModel(buildProcessModel(descriptor));
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
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
        ) : !model ? (
          <div style={{ padding: 24, color: C.fgMuted, fontSize: 13 }}>
            Loading process map…
          </div>
        ) : (
          <ProcessSurface model={model} />
        )}
      </div>
    </div>
  );
}
