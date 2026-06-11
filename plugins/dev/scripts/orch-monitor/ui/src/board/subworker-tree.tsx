// subworker-tree.tsx — the worker-detail v2 subworker count + compact tree
// (CTL-925 / WORKER-DETAIL v2 Pass B §5C). Fetches the subagent tree from
// /api/worker/<orchId>/<ticket>/subagents and shows "N subworkers" + a compact
// indented tree (subagentType · description, with a dim messageCount/todo suffix).
//
// HONEST DEGRADED STATES (§5C, GROUND-TRUTH verified on mini 2026-06-10):
//   • 404 — for an execution-core worker the orchId (=ticket) has NO matching
//     per-orch run dir (EC workers live under .../execution-core/workers/<TICKET>/,
//     not a scanned orch dir), so the endpoint 404s. We render "subworkers — ↯ (no
//     orchestrator stream for this run)" — NEVER a fabricated zero. This is a real
//     plumbing gap noted for a Pass-B follow-up (an EC-worker stream-file path
//     resolution on the endpoint).
//   • 0 children — a worker that spawned no subagents shows "no subworkers"
//     (root with 0 children), not an error.
// The count + flatten + orchId derivation are the PURE subagent-data.ts helpers
// (unit-tested); this component is the fetch + the skin.

import { useEffect, useState } from "react";
import {
  resolveSubagentOrchId,
  countSubagents,
  flattenSubagentRows,
  shortenDescription,
  type SubagentNode,
  type SubagentsResponse,
} from "./subagent-data";

const C = {
  s2: "#161a21",
  s3: "#1c222b",
  border: "#262d36",
  fg: "#e6e9ef",
  fgMuted: "#8b93a1",
  fgDim: "#5b626f",
  mono: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
} as const;

type FetchState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "loaded"; tree: SubagentNode }
  | { kind: "no-stream" } // 404 — no orchestrator run dir for this (EC) worker
  | { kind: "error" };

function useSubagents(orchId: string | null, ticket: string | undefined): FetchState {
  const [state, setState] = useState<FetchState>({ kind: "idle" });

  useEffect(() => {
    if (!orchId || !ticket) {
      setState({ kind: "idle" });
      return;
    }
    let alive = true;
    setState({ kind: "loading" });
    void (async () => {
      try {
        const res = await fetch(
          `/api/worker/${encodeURIComponent(orchId)}/${encodeURIComponent(ticket)}/subagents`,
        );
        if (!alive) return;
        if (res.status === 404) {
          // Honest degraded: no per-orch run dir for this EC worker (§5C).
          setState({ kind: "no-stream" });
          return;
        }
        if (!res.ok) {
          setState({ kind: "error" });
          return;
        }
        const body = (await res.json()) as SubagentsResponse;
        setState({ kind: "loaded", tree: body.tree });
      } catch {
        if (alive) setState({ kind: "error" });
      }
    })();
    return () => {
      alive = false;
    };
  }, [orchId, ticket]);

  return state;
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div
      data-worker-subworkers
      style={{
        background: C.s2,
        border: `1px solid ${C.border}`,
        borderRadius: 8,
        padding: "10px 12px",
        minWidth: 0,
      }}
    >
      <div
        style={{
          font: `10px ${C.mono}`,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: C.fgMuted,
          marginBottom: 8,
        }}
      >
        Subworkers
      </div>
      {children}
    </div>
  );
}

function TreeRow({
  depth,
  subagentType,
  description,
  messageCount,
  todoCount,
}: {
  depth: number;
  subagentType: string | null;
  description: string | null;
  messageCount: number;
  todoCount: number;
}) {
  const desc = shortenDescription(description);
  return (
    <div
      data-subworker-row
      data-depth={depth}
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: 8,
        padding: "2px 0",
        paddingLeft: depth * 14,
        font: `11px ${C.mono}`,
        minWidth: 0,
      }}
    >
      <span style={{ color: C.fgDim, flex: "0 0 auto" }}>{depth > 0 ? "└" : "▸"}</span>
      <span style={{ color: "#4ea1ff", flex: "0 0 auto" }}>
        {subagentType ?? "subagent"}
      </span>
      {desc && (
        <span
          style={{
            color: C.fgMuted,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {desc}
        </span>
      )}
      <span style={{ flex: 1 }} />
      {todoCount > 0 && (
        <span style={{ color: C.fgDim, flex: "0 0 auto" }}>{todoCount} todo</span>
      )}
      <span style={{ color: C.fgDim, flex: "0 0 auto" }}>{messageCount} msg</span>
    </div>
  );
}

export function SubworkerTree({
  workerName,
  ticket,
}: {
  workerName: string | undefined;
  ticket: string | undefined;
}) {
  const orchId = resolveSubagentOrchId(workerName, ticket);
  const state = useSubagents(orchId, ticket);

  if (state.kind === "idle" || state.kind === "loading") {
    return (
      <Card>
        <div style={{ font: `11px ${C.mono}`, color: C.fgMuted }}>
          {state.kind === "loading" ? "loading subworkers…" : "—"}
        </div>
      </Card>
    );
  }

  if (state.kind === "no-stream") {
    return (
      <Card>
        <div
          data-subworkers-no-stream
          style={{ font: `11px ${C.mono}`, color: C.fgDim }}
          title="execution-core workers have no per-orchestrator run dir — endpoint 404; EC stream-file resolution is a Pass-B follow-up"
        >
          — ↯ no orchestrator stream for this run
        </div>
      </Card>
    );
  }

  if (state.kind === "error") {
    return (
      <Card>
        <div style={{ font: `11px ${C.mono}`, color: C.fgDim }}>
          subworkers unavailable
        </div>
      </Card>
    );
  }

  const count = countSubagents(state.tree);
  const { rows, total, truncated } = flattenSubagentRows(state.tree);

  return (
    <Card>
      <div
        data-subworkers-count={count}
        style={{ font: `13px ${C.mono}`, color: C.fg, fontWeight: 600, marginBottom: 8 }}
      >
        {count === 0 ? "no subworkers" : `${count} subworker${count === 1 ? "" : "s"}`}
      </div>
      {rows.length > 0 && (
        <div data-subworker-tree style={{ maxHeight: 240, overflow: "auto" }}>
          {rows.map((r, i) => (
            <TreeRow
              key={r.toolUseId ?? `${r.depth}-${i}`}
              depth={r.depth}
              subagentType={r.subagentType}
              description={r.description}
              messageCount={r.messageCount}
              todoCount={r.todoCount}
            />
          ))}
          {truncated && (
            <div style={{ font: `10px ${C.mono}`, color: C.fgDim, paddingTop: 4 }}>
              … {total - rows.length} more
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
