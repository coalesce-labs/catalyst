import { useEffect, useRef, useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import type { BoardTicket, WorkflowSubStep } from "@/board/types";

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
      <span
        style={{ fontFamily: "monospace", fontSize: 10, opacity: 0.4 }}
      >
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
          width: 480,
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

        <div style={{ overflowY: "auto", flex: 1, padding: "16px" }}>
          <div
            style={{
              fontSize: 11,
              fontWeight: 600,
              opacity: 0.5,
              marginBottom: 8,
              letterSpacing: 1,
            }}
          >
            WORKFLOW SUB-STEPS
          </div>
          <SubStepSection ticketId={ticket.id} />
        </div>
      </SheetContent>
    </Sheet>
  );
}
