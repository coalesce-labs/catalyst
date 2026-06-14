// derivations-rail.tsx — CTL-1103 Phase 4: per-rule entity list + derivation trees.
// Shown when the operator selects a firing rule. Each entity expands to a
// /api/beliefs/why trace rendered via <DerivationTree/>.
import { useEffect, useState } from "react";
import { DerivationTree } from "@/components/governance/derivation-tree";
import { type TraceResult, isTraceResult, emptyTrace } from "@/lib/why-model";
import { subjectToTicket } from "./derivations-rail-model";
import { ChevronRight, ChevronDown } from "lucide-react";

interface EntityRowProps {
  subject: string;
  onOpenSource?: (ruleId: string) => void;
}

function EntityRow({ subject, onOpenSource }: EntityRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [trace, setTrace] = useState<TraceResult | null>(null);
  const ticket = subjectToTicket(subject);

  useEffect(() => {
    if (!expanded || !ticket) return;
    fetch(`/api/beliefs/why?ticket=${encodeURIComponent(ticket)}`)
      .then((r) => (r.ok ? (r.json() as Promise<unknown>) : null))
      .then((d) => setTrace(isTraceResult(d) ? d : emptyTrace(ticket ?? "")))
      .catch(() => setTrace(emptyTrace(ticket ?? "")));
  }, [expanded, ticket]);

  return (
    <div className="border-b last:border-0">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-muted/50 transition-colors"
        onClick={() => setExpanded((e) => !e)}
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
        )}
        <span className="font-mono text-xs">{subject}</span>
      </button>
      {expanded && (
        <div className="px-3 pb-2">
          {trace === null ? (
            <p className="text-xs text-muted-foreground">Loading…</p>
          ) : trace.beliefs.length === 0 ? (
            <p className="text-xs text-muted-foreground">No derivation available.</p>
          ) : (
            <DerivationTree trace={trace} onOpenSource={onOpenSource} />
          )}
        </div>
      )}
    </div>
  );
}

interface DerivationsRailProps {
  ruleId: string;
  subjects: string[];
  onOpenSource?: (ruleId: string) => void;
}

export function DerivationsRail({ ruleId, subjects, onOpenSource }: DerivationsRailProps) {
  if (subjects.length === 0) {
    return (
      <div className="rounded-lg border bg-card p-4 text-xs text-muted-foreground">
        <span className="font-mono">{ruleId}</span> — not currently firing.
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-card overflow-hidden">
      <div className="border-b px-3 py-2 text-xs font-medium text-muted-foreground">
        <span className="font-mono">{ruleId}</span> — {subjects.length} subject
        {subjects.length !== 1 ? "s" : ""} firing
      </div>
      {subjects.map((subject) => (
        <EntityRow key={subject} subject={subject} onOpenSource={onOpenSource} />
      ))}
    </div>
  );
}
