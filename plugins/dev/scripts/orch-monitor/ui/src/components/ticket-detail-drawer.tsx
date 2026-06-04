import { useEffect, useRef, useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@/components/ui/tabs";
import { EmptyState } from "@/components/ui/empty-state";
import type { BoardTicket, WorkflowSubStep } from "@/board/types";
import { TicketGantt } from "./ticket-gantt";
import { CommsView } from "./comms-view";
import { phaseColor, fmtCost, fmtTokens } from "@/lib/formatters";
import { DollarSign } from "lucide-react";

// ---------------------------------------------------------------------------
// Sub-step list (kept under the Gantt tab)
// ---------------------------------------------------------------------------

type SubStepStatus = "loading" | "ok" | "empty" | "error";

function SubStepRow({ step }: { step: WorkflowSubStep }) {
  const icon =
    step.status === "complete" ? "✓" : step.status === "failed" ? "✗" : "·";
  const color =
    step.status === "complete"
      ? "#39d07a"
      : step.status === "failed"
        ? "#ef5d5d"
        : "#4ea1ff";
  const time = new Date(step.ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "4px 0",
        borderBottom: "1px solid rgba(255,255,255,0.06)",
      }}
    >
      <span
        style={{ fontFamily: "monospace", fontSize: 12, color, minWidth: 12 }}
      >
        {icon}
      </span>
      <span style={{ flex: 1, fontSize: 12 }}>
        <span style={{ opacity: 0.6 }}>{step.workflowName}/</span>
        {step.stepLabel}
      </span>
      <span style={{ fontFamily: "monospace", fontSize: 10, opacity: 0.4 }}>
        {time}
      </span>
    </div>
  );
}

function SubStepSection({ ticketId }: { ticketId: string }) {
  const [subSteps, setSubSteps] = useState<WorkflowSubStep[]>([]);
  const [status, setStatus] = useState<SubStepStatus>("loading");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function fetch_() {
      try {
        const resp = await fetch(
          `/api/ticket-substeps?ticket=${encodeURIComponent(ticketId)}`,
        );
        if (cancelled) return;
        if (!resp.ok) {
          setStatus("error");
          return;
        }
        const data = (await resp.json()) as { subSteps: WorkflowSubStep[] };
        if (!cancelled) {
          setSubSteps(data.subSteps ?? []);
          setStatus(data.subSteps?.length ? "ok" : "empty");
        }
      } catch {
        if (!cancelled) setStatus("error");
      }
    }
    void fetch_();
    pollRef.current = setInterval(() => void fetch_(), 3000);
    return () => {
      cancelled = true;
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [ticketId]);

  if (status === "loading")
    return <div style={{ fontSize: 12, opacity: 0.4 }}>Loading…</div>;
  if (status === "error")
    return (
      <div style={{ fontSize: 12, opacity: 0.4 }}>
        Could not load sub-steps.
      </div>
    );
  if (status === "empty")
    return (
      <div style={{ fontSize: 12, opacity: 0.4 }}>
        No workflow sub-steps recorded yet.
      </div>
    );
  return (
    <div>
      {subSteps.map((s, i) => (
        <SubStepRow key={`${s.ts}-${i}`} step={s} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cost tab
// ---------------------------------------------------------------------------

function CostTab({ ticket }: { ticket: BoardTicket }) {
  const hasCost = ticket.costUSD != null && ticket.costUSD > 0;
  const hasPhaseCosts =
    ticket.phaseCosts != null && Object.keys(ticket.phaseCosts).length > 0;

  if (!hasCost && !hasPhaseCosts) {
    return (
      <EmptyState icon={DollarSign} message="No cost data recorded yet" />
    );
  }

  return (
    <div style={{ fontSize: 12 }}>
      {/* Ticket totals */}
      <div
        style={{
          display: "flex",
          gap: 24,
          padding: "10px 0",
          borderBottom: "1px solid rgba(255,255,255,0.08)",
          marginBottom: 12,
        }}
      >
        <div>
          <div style={{ opacity: 0.5, fontSize: 10, marginBottom: 2 }}>TOTAL COST</div>
          <div style={{ fontFamily: "monospace", fontSize: 14 }}>
            {fmtCost(ticket.costUSD ?? 0)}
          </div>
        </div>
        <div>
          <div style={{ opacity: 0.5, fontSize: 10, marginBottom: 2 }}>TOKENS</div>
          <div style={{ fontFamily: "monospace", fontSize: 14 }}>
            {fmtTokens(ticket.tokens ?? 0)}
          </div>
        </div>
        {ticket.turns != null && ticket.turns > 0 && (
          <div>
            <div style={{ opacity: 0.5, fontSize: 10, marginBottom: 2 }}>TURNS</div>
            <div style={{ fontFamily: "monospace", fontSize: 14 }}>
              {ticket.turns}
            </div>
          </div>
        )}
      </div>

      {/* Per-phase breakdown */}
      {hasPhaseCosts && (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
          <thead>
            <tr style={{ opacity: 0.5 }}>
              <th style={{ textAlign: "left", padding: "2px 4px", fontWeight: 500 }}>Phase</th>
              <th style={{ textAlign: "right", padding: "2px 4px", fontWeight: 500 }}>Cost</th>
              <th style={{ textAlign: "right", padding: "2px 4px", fontWeight: 500 }}>Tokens</th>
              <th style={{ textAlign: "right", padding: "2px 4px", fontWeight: 500 }}>Turns</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(ticket.phaseCosts!).map(([phase, cost]) => (
              <tr key={phase} style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }}>
                <td style={{ padding: "4px 4px" }}>
                  <span
                    style={{
                      display: "inline-block",
                      width: 8,
                      height: 8,
                      borderRadius: 2,
                      background: phaseColor(phase),
                      marginRight: 6,
                      verticalAlign: "middle",
                    }}
                  />
                  {phase}
                </td>
                <td style={{ textAlign: "right", padding: "4px 4px", fontFamily: "monospace" }}>
                  {fmtCost(cost.costUSD)}
                </td>
                <td style={{ textAlign: "right", padding: "4px 4px", fontFamily: "monospace" }}>
                  {fmtTokens(cost.tokens)}
                </td>
                <td style={{ textAlign: "right", padding: "4px 4px", fontFamily: "monospace", opacity: 0.6 }}>
                  {cost.turns}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Drawer
// ---------------------------------------------------------------------------

interface TicketDetailDrawerProps {
  ticket: BoardTicket;
  onClose: () => void;
}

export function TicketDetailDrawer({
  ticket,
  onClose,
}: TicketDetailDrawerProps) {
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent
        side="right"
        style={{
          width: 680,
          display: "flex",
          flexDirection: "column",
          gap: 0,
          padding: 0,
        }}
      >
        <SheetHeader
          style={{
            padding: "12px 16px",
            borderBottom: "1px solid rgba(255,255,255,0.08)",
          }}
        >
          <SheetTitle
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 14,
            }}
          >
            <span style={{ fontFamily: "monospace" }}>{ticket.id}</span>
            <span style={{ fontSize: 11, opacity: 0.5 }}>·</span>
            <span style={{ fontSize: 12, opacity: 0.7 }}>{ticket.phase}</span>
          </SheetTitle>
          <SheetDescription style={{ fontSize: 12, opacity: 0.6, marginTop: 2 }}>
            {ticket.title}
          </SheetDescription>
        </SheetHeader>

        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <Tabs
            defaultValue="gantt"
            style={{ display: "flex", flexDirection: "column", flex: 1, overflow: "hidden" }}
          >
            <TabsList style={{ margin: "8px 16px 0", flexShrink: 0 }}>
              <TabsTrigger value="gantt">Gantt</TabsTrigger>
              <TabsTrigger value="cost">Cost</TabsTrigger>
              <TabsTrigger value="comms">Comms</TabsTrigger>
            </TabsList>

            {/* Gantt tab — phase timing bars + sub-steps */}
            <TabsContent
              value="gantt"
              style={{ flex: 1, overflowY: "auto", padding: "16px" }}
            >
              <TicketGantt ticket={ticket} />
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  opacity: 0.5,
                  margin: "20px 0 8px",
                  letterSpacing: 1,
                }}
              >
                WORKFLOW SUB-STEPS
              </div>
              <SubStepSection ticketId={ticket.id} />
            </TabsContent>

            {/* Cost tab — ticket totals + per-phase breakdown */}
            <TabsContent
              value="cost"
              style={{ flex: 1, overflowY: "auto", padding: "16px" }}
            >
              <CostTab ticket={ticket} />
            </TabsContent>

            {/* Comms tab — pre-filtered to this ticket's orch channel */}
            <TabsContent
              value="comms"
              style={{ flex: 1, minHeight: 0, overflow: "hidden" }}
            >
              <div style={{ height: "100%", overflow: "hidden" }}>
                <CommsView
                  initialFilter={{
                    channel: "orch-" + ticket.id,
                    types: null,
                    author: null,
                  }}
                />
              </div>
            </TabsContent>
          </Tabs>
        </div>
      </SheetContent>
    </Sheet>
  );
}
