// dep-graph-route.tsx — the /dep-graph route body (CTL-948).
// Subscribes to the resident board payload (same transport as Board.tsx +
// detail-route.tsx), filters to the repo scope, and renders <BacklogDepGraph>.
// The route is a standalone page (not inside <Shell>) so the full viewport is
// available for the graph canvas.

import { useEffect, useMemo, useState } from "react";
import { connectBoard } from "./board-client";
import { BacklogDepGraph } from "./dependency-graph";
import { useRepoScope } from "../hooks/use-repo-scope";
import { C } from "./board-tokens";
import type { BoardPayload } from "./types";

export function DepGraphRoute() {
  const [payload, setPayload] = useState<BoardPayload | null>(null);

  useEffect(() => {
    let alive = true;
    const conn = connectBoard({
      onSnapshot: (p) => { if (alive) setPayload(p); },
      onStatus: () => {},
    });
    return () => {
      alive = false;
      conn.close();
    };
  }, []);

  const repos = payload?.repos ?? [];
  const { scope } = useRepoScope(repos);
  const tickets = useMemo(
    () =>
      (payload?.tickets ?? []).filter(
        (t) => scope === "all" || t.repo === scope,
      ),
    [payload, scope],
  );

  const visibleIds = useMemo(() => new Set(tickets.map((t) => t.id)), [tickets]);

  return (
    <div
      style={{
        background: C.s0,
        color: C.fg,
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      }}
    >
      {/* Minimal subhead — mirrors the Board subhead strip style */}
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
        <h1 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Dependency Graph</h1>
        <span style={{ color: C.fgMuted, fontSize: 12 }}>
          Backlog tickets linked by blocked_by · left = blocker → right = dependent · click to open
        </span>
      </div>

      {/* Graph canvas — fills remaining height */}
      <div style={{ flex: 1, minHeight: 0 }}>
        {!payload ? (
          <div style={{ color: C.fgMuted, padding: 24 }}>Connecting to execution-core…</div>
        ) : (
          <BacklogDepGraph tickets={tickets} visibleIds={visibleIds} />
        )}
      </div>
    </div>
  );
}
